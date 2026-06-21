const INTERNAL_SOURCE_HEADER = "x-pcc-internal-source";
const INTERNAL_TOKEN_HEADER = "x-internal-token";
const EMAIL_WORKER_SOURCE = "email-worker";
const API_RECEIPT_PATH = "/internal/receipts";
const DEFAULT_RECEIPT_TO_ADDRESS = "purchases@purduephotoclub.org";
const DEFAULT_DEDUPE_TTL_SECONDS = 400 * 24 * 60 * 60;
const MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT_RETRY_SECONDS = 60;
const PURDUE_EMAIL_DOMAIN = "purdue.edu";

type ReceiptKind = "membership" | "rolls" | "prints";
type MembershipTier = "member" | "facilities";

interface TooCoolLineItem {
  amount: string;
  description: string;
  kind: ReceiptKind | null;
  quantity: number;
  tier: MembershipTier | null;
  totalCents: number;
}

export interface TooCoolReceipt {
  customerId: string;
  customerName: string;
  lineItems: TooCoolLineItem[];
  orderId: string;
  purchasedAt: string;
}

export interface ReceiptPayload {
  amount: string;
  customerEmail: string;
  customerName: string;
  idempotencyKey: string;
  kind: ReceiptKind;
  orderId: string;
  productName: string;
  purchasedAt: string;
  tier?: MembershipTier;
}

export interface ReceiptProcessResult {
  duplicate: boolean;
  status: number;
}

interface AttachmentLike {
  content?: ArrayBuffer | Uint8Array | string;
  contentType?: string;
  filename?: string;
  mimeType?: string;
}

interface ParsedMimeLike {
  attachments?: AttachmentLike[];
}

export function parseTooCoolReceiptText(text: string): TooCoolReceipt {
  const normalizedText = normalizePdfText(text);
  const lines = splitNonEmptyLines(normalizedText);

  const orderId = readOrderId(normalizedText, lines);
  const customerId = readCustomerId(normalizedText, lines).toLowerCase();
  const customerName = readCustomerName(normalizedText, lines, customerId);
  const purchasedAt = readPurchasedAt(normalizedText);
  const lineItems = readLineItems(lines);

  if (lineItems.length === 0) {
    throw new Error("TooCOOL receipt does not contain any supported line items.");
  }

  return {
    customerId,
    customerName,
    lineItems,
    orderId,
    purchasedAt,
  };
}

export function buildReceiptPayloads(receipt: TooCoolReceipt): ReceiptPayload[] {
  const customerEmail = toPurdueEmail(receipt.customerId);
  if (!customerEmail) {
    throw new Error("TooCOOL customer id cannot be converted to a Purdue email address.");
  }

  return receipt.lineItems.flatMap((item) => {
    if (!item.kind) {
      return [];
    }

    return [{
      amount: item.amount,
      customerEmail,
      customerName: receipt.customerName,
      idempotencyKey: createIdempotencyKey(receipt.orderId, item),
      kind: item.kind,
      orderId: receipt.orderId,
      productName: item.description,
      purchasedAt: receipt.purchasedAt,
      ...(item.kind === "membership" && item.tier ? { tier: item.tier } : {}),
    }];
  });
}

export async function processReceiptPayload(
  env: Env,
  payload: ReceiptPayload,
): Promise<ReceiptProcessResult> {
  const token = env.INTERNAL_TOKEN?.trim();
  if (!token) {
    throw new Error("INTERNAL_TOKEN is required for email-worker-to-API calls.");
  }
  if (!env.API_WORKER) {
    throw new Error("API_WORKER service binding is required for receipt fulfillment.");
  }
  if (!env.RECEIPT_DEDUPE) {
    throw new Error("RECEIPT_DEDUPE KV binding is required for receipt dedupe.");
  }

  const dedupeKey = `receipt:${payload.idempotencyKey}`;
  const existing = await env.RECEIPT_DEDUPE.get(dedupeKey);
  if (existing) {
    console.info("Receipt payload already processed.", {
      idempotencyKey: payload.idempotencyKey,
      kind: payload.kind,
      orderId: payload.orderId,
    });
    return { duplicate: true, status: 200 };
  }

  await env.RECEIPT_DEDUPE.put(
    dedupeKey,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      status: "processing",
    }),
    { expirationTtl: readDedupeTtl(env) },
  );

  const response = await env.API_WORKER.fetch(
    new Request(new URL(API_RECEIPT_PATH, "https://api.internal"), {
      body: JSON.stringify(payload),
      headers: {
        [INTERNAL_SOURCE_HEADER]: EMAIL_WORKER_SOURCE,
        [INTERNAL_TOKEN_HEADER]: token,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );

  if (!response.ok) {
    await env.RECEIPT_DEDUPE.delete(dedupeKey);
    const body = await readResponseBody(response);
    console.error("Receipt API rejected fulfillment payload.", {
      body,
      idempotencyKey: payload.idempotencyKey,
      orderId: payload.orderId,
      status: response.status,
    });
    throw new Error(`Receipt API returned HTTP ${response.status}.`);
  }

  await env.RECEIPT_DEDUPE.put(
    dedupeKey,
    JSON.stringify({
      completedAt: new Date().toISOString(),
      kind: payload.kind,
      orderId: payload.orderId,
      status: "fulfilled",
    }),
    { expirationTtl: readDedupeTtl(env) },
  );

  return { duplicate: false, status: response.status };
}

export async function extractPdfText(pdfBytes: ArrayBuffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const result = await extractText(new Uint8Array(pdfBytes), {
    mergePages: true,
  });
  return result.text;
}

async function handleReceiptEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const destination = normalizeEmail(message.to);
  if (destination !== getReceiptToAddress(env)) {
    message.setReject("Unexpected receipt mailbox.");
    return;
  }

  if (!isAuthorizedForwarder(message.from, env.ALLOWED_FORWARDERS)) {
    message.setReject("Unauthorized receipt sender.");
    return;
  }

  const rateLimitResponse = await checkEmailRateLimit(message, env);
  if (rateLimitResponse) {
    message.setReject("Too many receipt emails.");
    return;
  }

  const rawEmail = await readStreamWithLimit(message.raw, MAX_RAW_EMAIL_BYTES);
  const parsedEmail = await parseMime(rawEmail);
  const pdfAttachments = findPdfAttachments(parsedEmail);
  if (pdfAttachments.length === 0) {
    message.setReject("Receipt PDF attachment required.");
    return;
  }

  const processedCounts = await Promise.all(
    pdfAttachments.map((attachment) => processReceiptAttachment(env, attachment)),
  );
  const processedCount = processedCounts.reduce((total, count) => total + count, 0);

  if (processedCount === 0) {
    message.setReject("Receipt does not contain supported purchases.");
  }
}

async function processReceiptAttachment(env: Env, attachment: AttachmentLike) {
  const pdfBytes = readAttachmentBytes(attachment);
  if (pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new Error("Receipt PDF is too large.");
  }

  const text = await extractPdfText(pdfBytes);
  const payloads = buildReceiptPayloads(parseTooCoolReceiptText(text));
  await Promise.all(payloads.map((payload) => processReceiptPayload(env, payload)));
  return payloads.length;
}

async function parseMime(rawEmail: ArrayBuffer): Promise<ParsedMimeLike> {
  const PostalMime = (await import("postal-mime")).default;
  return await new PostalMime().parse(rawEmail) as ParsedMimeLike;
}

function findPdfAttachments(parsedEmail: ParsedMimeLike): AttachmentLike[] {
  return (parsedEmail.attachments ?? []).filter((attachment) => {
    const contentType = (attachment.mimeType ?? attachment.contentType ?? "").toLowerCase();
    const filename = (attachment.filename ?? "").toLowerCase();
    return contentType === "application/pdf" || filename.endsWith(".pdf");
  });
}

function readAttachmentBytes(attachment: AttachmentLike): ArrayBuffer {
  if (!attachment.content) {
    throw new Error("Receipt PDF attachment has no content.");
  }
  if (attachment.content instanceof ArrayBuffer) {
    return attachment.content;
  }
  if (attachment.content instanceof Uint8Array) {
    return copyToArrayBuffer(attachment.content);
  }

  const encoder = new TextEncoder();
  return copyToArrayBuffer(encoder.encode(attachment.content));
}

function copyToArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function normalizePdfText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function splitNonEmptyLines(text: string) {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

function readOrderId(text: string, lines: string[]) {
  const inline = readInlineLabelValue(text, "Order");
  if (inline && /^\d{4,}$/.test(inline)) {
    return inline;
  }

  const value = lines.find((line) => /^\d{5,}$/.test(line));
  if (!value) {
    throw new Error("Missing TooCOOL order id.");
  }
  return value;
}

function readCustomerId(text: string, lines: string[]) {
  const inline = readInlineLabelValue(text, "Customer ID");
  if (inline && /^[A-Za-z0-9._-]+$/.test(inline)) {
    return inline;
  }

  const value = lines.find((line) => /^[A-Za-z]{2,}[A-Za-z0-9._-]*\d{2,}$/.test(line));
  if (!value) {
    throw new Error("Missing TooCOOL customer id.");
  }
  return value;
}

function readInlineLabelValue(text: string, label: string) {
  const match = new RegExp(`\\b${label}:\\s*([^\\n]+)`, "i").exec(text);
  const value = match?.[1]?.trim() ?? "";
  return value && !/^[A-Za-z ]+:$/.test(value) ? value : null;
}

function readCustomerName(text: string, lines: string[], customerId: string) {
  const inlineMatch = /\n([^\n]+?)[ \t]+Order Date:/i.exec(text);
  if (inlineMatch?.[1]) {
    return cleanName(inlineMatch[1]);
  }

  const customerIdIndex = lines.findIndex((line) => line.toLowerCase() === customerId.toLowerCase());
  const stackedCandidate = customerIdIndex >= 0
    ? chooseStackedCustomerName(lines.slice(customerIdIndex + 1, customerIdIndex + 8))
    : "";
  if (stackedCandidate) {
    return stackedCandidate;
  }

  const orderLineIndex = lines.findIndex((line) => /\bOrder:\s*\d+/i.test(line));
  const candidate = orderLineIndex >= 0 ? lines[orderLineIndex + 1] : "";
  const cleaned = cleanName(candidate ?? "");
  if (!cleaned) {
    throw new Error("Missing TooCOOL customer name.");
  }
  return cleaned;
}

function chooseStackedCustomerName(candidates: string[]) {
  const names: string[] = [];
  for (const candidate of candidates) {
    const line = cleanName(candidate);
    if (
      /^[A-Za-z][A-Za-z.' -]+$/.test(line)
      && !/^(United States Of America|PAID|Items|Shipping|Sales Tax|Total)$/i.test(line)
    ) {
      names.push(line);
    }
  }

  return names.find((line) => line.split(/\s+/).length >= 3)
    ?? names.find((line) => line.split(/\s+/).length >= 2)
    ?? "";
}

function cleanName(value: string) {
  return value
    .replace(/\bOrder Date:.*$/i, "")
    .replace(/\bShip To:.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function readPurchasedAt(text: string) {
  const orderDate = readInlineLabelValue(text, "Order Date");
  if (orderDate) {
    return parseTooCoolDate(orderDate);
  }

  const stackedDate = findStackedDate(text);
  if (stackedDate) {
    return parseTooCoolDate(stackedDate);
  }

  const generatedDate = /Generated\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i.exec(text)?.[1]?.trim();
  if (generatedDate) {
    return new Date(`${generatedDate} UTC`).toISOString();
  }

  throw new Error("Missing TooCOOL order date.");
}

function findStackedDate(text: string) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function parseTooCoolDate(value: string) {
  const match = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(value);
  if (!match) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid TooCOOL order date.");
    }
    return date.toISOString();
  }

  const month = monthIndex(match[2]);
  if (month < 0) {
    throw new Error("Invalid TooCOOL order month.");
  }

  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return date.toISOString();
}

function monthIndex(value: string) {
  return [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(value.slice(0, 3).toLowerCase());
}

function readLineItems(lines: string[]): TooCoolLineItem[] {
  const headerIndex = lines.findIndex((line) => /^Quantity\s+Description\b/i.test(line));
  const items: TooCoolLineItem[] = [];
  if (headerIndex >= 0) {
    for (const line of lines.slice(headerIndex + 1)) {
      if (/^\(\d+\)|^PAID\b|^Shipping\b|^Sales Tax\b|^Thank you\b|^Generated\b/i.test(line)) {
        break;
      }

      const item = parseLineItem(line);
      if (item) {
        items.push(item);
      }
    }
  }

  return items.length > 0 ? items : readStackedLineItems(lines);
}

function readStackedLineItems(lines: string[]): TooCoolLineItem[] {
  const items: TooCoolLineItem[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\d{1,3}$/.test(lines[index])) {
      continue;
    }

    const tail = lines.slice(index + 1, index + 12);
    const firstMoneyIndex = tail.findIndex(isMoney);
    if (firstMoneyIndex <= 0) {
      continue;
    }

    const moneyValues = firstMoneyValues(tail, firstMoneyIndex);
    if (moneyValues.length < 4) {
      continue;
    }

    const description = normalizeDescription(tail.slice(0, firstMoneyIndex).join(" "));
    const totalCents = moneyToCents(moneyValues[3]);
    const classification = classifyLineItem(description, totalCents);
    items.push({
      amount: formatMoney(totalCents),
      description,
      kind: classification.kind,
      quantity: Number(lines[index]),
      tier: classification.tier,
      totalCents,
    });
  }

  return items;
}

function firstMoneyValues(values: string[], startIndex: number) {
  const moneyValues: string[] = [];
  for (let index = startIndex; index < values.length && moneyValues.length < 4; index += 1) {
    if (isMoney(values[index])) {
      moneyValues.push(values[index]);
    }
  }
  return moneyValues;
}

function parseLineItem(line: string): TooCoolLineItem | null {
  const match = /^(\d+)\s+(.+?)\s+(-?\d+(?:\.\d{2}))\s+(-?\d+(?:\.\d{2}))\s+(-?\d+(?:\.\d{2}))\s+(-?\d+(?:\.\d{2}))$/.exec(line);
  if (!match) {
    return null;
  }

  const quantity = Number(match[1]);
  const description = normalizeDescription(match[2]);
  const totalCents = moneyToCents(match[6]);
  const classification = classifyLineItem(description, totalCents);

  return {
    amount: formatMoney(totalCents),
    description,
    kind: classification.kind,
    quantity,
    tier: classification.tier,
    totalCents,
  };
}

function normalizeDescription(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 140);
}

function classifyLineItem(
  description: string,
  totalCents: number,
): { kind: ReceiptKind | null; tier: MembershipTier | null } {
  const normalized = description.toLowerCase();
  if (/\b(member|membership|dues)\b/.test(normalized)) {
    return {
      kind: "membership",
      tier: normalized.includes("facilit") || totalCents >= 3000 ? "facilities" : "member",
    };
  }
  if (/\b(print|prints|printing)\b/.test(normalized)) {
    return { kind: "prints", tier: null };
  }
  if (/\b(roll|rolls|film|develop|development|processing)\b/.test(normalized)) {
    return { kind: "rolls", tier: null };
  }
  return { kind: null, tier: null };
}

function toPurdueEmail(customerId: string) {
  const normalized = customerId.toLowerCase().trim();
  if (!/^[a-z0-9._-]{2,40}$/.test(normalized)) {
    return null;
  }
  return `${normalized}@${PURDUE_EMAIL_DOMAIN}`;
}

function createIdempotencyKey(orderId: string, item: TooCoolLineItem) {
  return [
    "toocool",
    orderId,
    item.kind ?? "unknown",
    slugify(item.description),
    String(item.totalCents),
  ].join(":");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "line-item";
}

function moneyToCents(value: string) {
  const [dollars = "0", cents = "0"] = value.split(".");
  return (Number(dollars) * 100) + Number(cents.padEnd(2, "0").slice(0, 2));
}

function isMoney(value: string) {
  return /^-?\d+(?:\.\d{2})$/.test(value);
}

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function readDedupeTtl(env: Env) {
  const parsed = Number(env.RECEIPT_DEDUPE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_DEDUPE_TTL_SECONDS;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 2_000);
  }
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  byteLimit: number,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > byteLimit) {
      throw new Error("Receipt email is too large.");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function getReceiptToAddress(env: Env) {
  return normalizeEmail(env.RECEIPT_TO_ADDRESS || DEFAULT_RECEIPT_TO_ADDRESS);
}

function isAuthorizedForwarder(sender: string, allowlist: string | undefined) {
  const normalizedSender = normalizeEmail(sender);
  const rules = readForwarderRules(allowlist);

  if (rules.length === 0) {
    return false;
  }

  return rules.some((rule) => {
    if (rule.startsWith("*@")) {
      return normalizedSender.endsWith(rule.slice(1));
    }
    return normalizedSender === normalizeEmail(rule);
  });
}

function readForwarderRules(allowlist: string | undefined) {
  const rules: string[] = [];
  for (const rawRule of (allowlist || "").split(",")) {
    const rule = rawRule.trim().toLowerCase();
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

function normalizeEmail(value: string | undefined) {
  return (value || "").trim().toLowerCase();
}

async function checkEmailRateLimit(message: ForwardableEmailMessage, env: Env) {
  if (!env.EMAIL_WORKER_RATE_LIMITER) {
    return null;
  }

  const outcome = await env.EMAIL_WORKER_RATE_LIMITER.limit({
    key: `email:${normalizeEmail(message.from)}`,
  });
  return outcome.success ? null : outcome;
}

async function checkHealthRateLimit(request: Request, env: Env, pathname: string) {
  if (!env.EMAIL_WORKER_RATE_LIMITER) {
    return null;
  }

  const outcome = await env.EMAIL_WORKER_RATE_LIMITER.limit({
    key: `health:${pathname}:${getClientIdentity(request)}`,
  });
  if (outcome.success) {
    return null;
  }

  return Response.json(
    {
      error: "Too many requests.",
      success: false,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(RATE_LIMIT_RETRY_SECONDS),
      },
      status: 429,
    },
  );
}

function getClientIdentity(request: Request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function healthResponse() {
  return Response.json({
    ok: true,
    service: "purdue-photography-club-email",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      const rateLimitResponse = await checkHealthRateLimit(request, env, url.pathname);
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      return healthResponse();
    }

    return Response.json({ error: "Not Found." }, { status: 404 });
  },

  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _context: ExecutionContext,
  ): Promise<void> {
    try {
      await handleReceiptEmail(message, env);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown receipt email error.";
      console.error("Receipt email processing failed.", { error: reason });
      message.setReject("Receipt processing failed.");
    }
  },
} satisfies ExportedHandler<Env>;
