import { buildReceiptPayloads, parseTooCoolReceiptText } from "./receipt-parser.ts";
import type { ReceiptPayload } from "./receipt-parser.ts";
import type { Address, Email as ParsedEmail } from "postal-mime";
export { buildReceiptPayloads, parseTooCoolReceiptText } from "./receipt-parser.ts";
export type { ReceiptPayload, TooCoolReceipt } from "./receipt-parser.ts";

const INTERNAL_SOURCE_HEADER = "x-pcc-internal-source";
const INTERNAL_TOKEN_HEADER = "x-internal-token";
const EMAIL_WORKER_SOURCE = "email-worker";
const API_RECEIPT_PATH = "/internal/receipts";
const API_RECEIPT_CONFIG_PATH = "/internal/receipts/config";
const DEFAULT_RECEIPT_TO_ADDRESS = "purchases@purduephotoclub.org";
const DEFAULT_DEDUPE_TTL_SECONDS = 400 * 24 * 60 * 60;
const DEFAULT_RETRY_TTL_SECONDS = 30 * 24 * 60 * 60;
const RECEIPT_INGRESS_CONFIG_CACHE_KEY = "receipt-ingress-config:v1";
const RECEIPT_INGRESS_CONFIG_CACHE_TTL_SECONDS = 15 * 60;
const MAX_RECEIPT_INGRESS_CONFIG_CACHE_BYTES = 2_048;
const MAX_RECEIPT_INGRESS_CONFIG_RESPONSE_BYTES = 4_096;
const RECEIPT_PROCESSING_LEASE_SECONDS = 5 * 60;
const RECEIPT_RETRY_BASE_SECONDS = 5 * 60;
const RECEIPT_RETRY_MAX_SECONDS = 24 * 60 * 60;
const RECEIPT_RETRY_MAX_ATTEMPTS = 5;
const MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const MAX_FULFILLMENT_PAYLOADS_PER_EMAIL = 50;
const MAX_RECEIPT_PDF_ATTACHMENTS = 4;
const RATE_LIMIT_RETRY_SECONDS = 60;

export interface ReceiptProcessResult {
  duplicate: boolean;
  queued?: boolean;
  status: number;
}

interface ReceiptQueueRecord {
  attempts: number;
  error?: string;
  nextAttemptAt?: string;
  payload?: ReceiptPayload;
  payloadFingerprint?: string;
  processingStartedAt?: string;
  status: "failed" | "fulfilled" | "processing" | "retry";
}

interface AttachmentLike {
  content?: ArrayBuffer | Uint8Array | string;
  filename?: string | null;
  mimeType?: string;
}

interface ReceiptIngressConfig {
  allowedSenderEmail: string;
  receiptToAddress: string;
}

interface CachedReceiptIngressConfig extends ReceiptIngressConfig {
  cachedAt: number;
}

export async function processReceiptPayload(
  env: Env,
  payload: ReceiptPayload,
  nowIso = new Date().toISOString(),
): Promise<ReceiptProcessResult> {
  const token = readEmailWorkerInternalToken(env);
  if (!env.API_WORKER) {
    throw new Error("API_WORKER service binding is required for receipt fulfillment.");
  }
  if (!env.RECEIPT_DEDUPE) {
    throw new Error("RECEIPT_DEDUPE KV binding is required for receipt dedupe.");
  }

  const dedupeKey = `receipt:${payload.idempotencyKey}`;
  const retryKey = `receipt-retry:${payload.idempotencyKey}`;
  const failedKey = `receipt-failed:${payload.idempotencyKey}`;
  const payloadFingerprint = await createReceiptPayloadFingerprint(payload);
  const terminal = readReceiptQueueRecord(
    await env.RECEIPT_DEDUPE.get(dedupeKey),
  );
  if (terminal?.status === "fulfilled") {
    if (
      terminal.payloadFingerprint &&
      terminal.payloadFingerprint !== payloadFingerprint
    ) {
      await putReceiptQueueRecord(env, failedKey, {
        attempts: 1,
        error: "Receipt payload conflicts with completed fulfillment state.",
        payload,
        payloadFingerprint,
        status: "failed",
      });
      await env.RECEIPT_DEDUPE.delete(retryKey);
      throw new Error("Receipt payload conflicts with completed fulfillment state.");
    }

    await cleanupReceiptQueueState(
      env,
      retryKey,
      failedKey,
      payload,
      payloadFingerprint,
    );
    console.info("Receipt payload already processed.", {
      idempotencyKey: payload.idempotencyKey,
      kind: payload.kind,
      orderId: payload.orderId,
    });
    return { duplicate: true, status: 200 };
  }

  const existing = readReceiptQueueRecord(
    await env.RECEIPT_DEDUPE.get(retryKey),
  );
  if (
    existing?.payload &&
    !areReceiptPayloadsEqual(existing.payload, payload)
  ) {
    await putReceiptQueueRecord(env, failedKey, {
      attempts: Math.max(0, existing.attempts) + 1,
      error: "Receipt payload conflicts with queued fulfillment state.",
      payload,
      payloadFingerprint,
      status: "failed",
    });
    throw new Error("Receipt payload conflicts with queued fulfillment state.");
  }

  const nowMs = Date.parse(nowIso);
  const processingStartedAt = existing?.processingStartedAt
    ? Date.parse(existing.processingStartedAt)
    : Number.NaN;
  if (
    existing?.status === "processing" &&
    Number.isFinite(processingStartedAt) &&
    nowMs - processingStartedAt < RECEIPT_PROCESSING_LEASE_SECONDS * 1_000
  ) {
    await putReceiptQueueRecord(env, retryKey, {
      ...existing,
      payload,
    });
    return { duplicate: false, queued: true, status: 202 };
  }

  if (
    existing?.status === "retry" &&
    existing.nextAttemptAt &&
    existing.nextAttemptAt > nowIso
  ) {
    await putReceiptQueueRecord(env, retryKey, {
      ...existing,
      payload,
      payloadFingerprint,
    });
    return { duplicate: false, queued: true, status: 202 };
  }

  await putReceiptQueueRecord(env, retryKey, {
    attempts: existing?.attempts ?? 0,
    payload,
    payloadFingerprint,
    processingStartedAt: nowIso,
    status: "processing",
  });
  await deleteMatchingReceiptFailure(
    env,
    failedKey,
    payload,
    payloadFingerprint,
  );

  let response: Response;
  try {
    response = await env.API_WORKER.fetch(
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
  } catch (error) {
    await queueReceiptRetry(
      env,
      retryKey,
      failedKey,
      payload,
      payloadFingerprint,
      existing,
      nowIso,
      error,
    );
    return { duplicate: false, queued: true, status: 202 };
  }

  if (!response.ok) {
    const body = await readResponseBody(response);
    console.error("Receipt API rejected fulfillment payload.", {
      body,
      idempotencyKey: payload.idempotencyKey,
      orderId: payload.orderId,
      status: response.status,
    });
    if (isPermanentReceiptApiFailure(response.status)) {
      await putReceiptQueueRecord(env, failedKey, {
        attempts: Math.max(0, existing?.attempts ?? 0) + 1,
        error: `Receipt API returned HTTP ${response.status}.`,
        payload,
        payloadFingerprint,
        status: "failed",
      });
      await env.RECEIPT_DEDUPE.delete(retryKey);
      throw new Error(`Receipt API returned HTTP ${response.status}.`);
    }

    await queueReceiptRetry(
      env,
      retryKey,
      failedKey,
      payload,
      payloadFingerprint,
      existing,
      nowIso,
      new Error(`Receipt API returned HTTP ${response.status}.`),
    );
    return { duplicate: false, queued: true, status: 202 };
  }

  await env.RECEIPT_DEDUPE.put(
    dedupeKey,
    JSON.stringify({
      completedAt: new Date().toISOString(),
      kind: payload.kind,
      orderId: payload.orderId,
      payloadFingerprint,
      status: "fulfilled",
    }),
    { expirationTtl: readDedupeTtl(env) },
  );
  await cleanupReceiptQueueState(
    env,
    retryKey,
    failedKey,
    payload,
    payloadFingerprint,
  );

  return { duplicate: false, status: response.status };
}

export async function processReceiptPayloadBatch(
  env: Env,
  payloads: readonly ReceiptPayload[],
): Promise<void> {
  let failures: unknown[] = [];
  for (const payload of payloads) {
    try {
      await processReceiptPayload(env, payload);
    } catch (error) {
      failures = [...failures, error];
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} receipt fulfillment item(s) failed.`,
    );
  }
}

export async function processReceiptPayloadGroups(
  env: Env,
  payloadGroups: readonly (readonly ReceiptPayload[])[],
) {
  const payloads = payloadGroups.flat();
  if (payloads.length > MAX_FULFILLMENT_PAYLOADS_PER_EMAIL) {
    throw new Error("Receipt contains too many fulfillment items across attachments.");
  }

  await processReceiptPayloadBatch(env, payloads);
  return payloads.length;
}

export async function retryQueuedReceiptPayloads(
  env: Env,
  nowIso = new Date().toISOString(),
) {
  let cursor: string | undefined;
  let failed = 0;
  let ingressConfig: ReceiptIngressConfig | null = null;
  let retried = 0;
  let scanned = 0;
  let succeeded = 0;

  do {
    const page = await env.RECEIPT_DEDUPE.list({
      cursor,
      prefix: "receipt-retry:",
    });
    scanned += page.keys.length;
    if (page.keys.length > 0 && !ingressConfig) {
      ingressConfig = await getReceiptIngressConfig(env);
    }

    for (const key of page.keys) {
      const record = readReceiptQueueRecord(
        await env.RECEIPT_DEDUPE.get(key.name),
      );
      if (!record?.payload || !ingressConfig) {
        continue;
      }
      if (record.payload.sourceSender !== ingressConfig.allowedSenderEmail) {
        failed += 1;
        await deadLetterQueuedReceiptForSender(
          env,
          key.name,
          record,
        );
        continue;
      }
      if (!isReceiptQueueRecordDue(record, nowIso)) {
        continue;
      }

      retried += 1;
      try {
        const result = await processReceiptPayload(env, record.payload, nowIso);
        if (result.queued) {
          failed += 1;
        } else {
          succeeded += 1;
        }
      } catch (error) {
        failed += 1;
        console.error("Queued receipt retry failed permanently.", {
          error: error instanceof Error ? error.message : "Unknown receipt retry error.",
          idempotencyKey: record.payload.idempotencyKey,
        });
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { failed, retried, scanned, succeeded };
}

export async function extractPdfText(pdfBytes: ArrayBuffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const result = await extractText(new Uint8Array(pdfBytes), {
    mergePages: false,
  });
  return result.text.join("\n");
}

async function handleReceiptEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const destination = normalizeEmail(message.to);
  if (destination !== DEFAULT_RECEIPT_TO_ADDRESS) {
    message.setReject("Unexpected receipt mailbox.");
    return;
  }

  if (
    !Number.isSafeInteger(message.rawSize) ||
    message.rawSize < 0 ||
    message.rawSize > MAX_RAW_EMAIL_BYTES
  ) {
    throw new Error("Receipt email is too large.");
  }

  const rateLimitResponse = await checkEmailRateLimit(message, env);
  if (rateLimitResponse) {
    message.setReject("Too many receipt emails.");
    return;
  }

  const ingressConfig = await getReceiptIngressConfig(env);
  const sourceSender = normalizeEmail(message.from);
  if (sourceSender !== ingressConfig.allowedSenderEmail) {
    message.setReject("Unauthorized receipt sender.");
    return;
  }

  const rawEmail = await readStreamWithLimit(message.raw, MAX_RAW_EMAIL_BYTES);
  const parsedEmail = await parseMime(rawEmail);
  if (!(await hasMatchingFromHeader(parsedEmail, sourceSender))) {
    message.setReject("Receipt From header does not match sender.");
    return;
  }
  const pdfAttachments = findPdfAttachments(parsedEmail);
  if (pdfAttachments.length === 0) {
    message.setReject("Receipt PDF attachment required.");
    return;
  }
  if (pdfAttachments.length > MAX_RECEIPT_PDF_ATTACHMENTS) {
    message.setReject("Too many receipt PDF attachments.");
    return;
  }

  const sourceMessageId = normalizeSourceMessageId(
    message.headers.get("message-id"),
  );
  const payloadGroups = await Promise.all(
    pdfAttachments.map(async (attachment) => {
      const payloads = await readReceiptAttachmentPayloads(attachment);
      return payloads.map((payload) => ({
        ...payload,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        sourceSender,
      }));
    }),
  );
  const processedCount = await processReceiptPayloadGroups(env, payloadGroups);

  if (processedCount === 0) {
    message.setReject("Receipt does not contain supported purchases.");
  }
}

async function readReceiptAttachmentPayloads(attachment: AttachmentLike) {
  const pdfBytes = readAttachmentBytes(attachment);
  if (pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new Error("Receipt PDF is too large.");
  }

  const text = await extractPdfText(pdfBytes);
  return buildReceiptPayloads(parseTooCoolReceiptText(text));
}

async function parseMime(rawEmail: ArrayBuffer): Promise<ParsedEmail> {
  const PostalMime = (await import("postal-mime")).default;
  return await new PostalMime().parse(rawEmail);
}

async function hasMatchingFromHeader(
  parsedEmail: ParsedEmail,
  expectedSender: string,
) {
  const fromHeaders = parsedEmail.headers.filter(
    (header) => header.key.toLowerCase() === "from",
  );
  if (fromHeaders.length !== 1) {
    return false;
  }

  const { addressParser } = await import("postal-mime");
  const addresses = addressParser(fromHeaders[0]?.value ?? "");
  if (addresses.length !== 1) {
    return false;
  }

  return readMailboxAddress(addresses[0]) === expectedSender &&
    readMailboxAddress(parsedEmail.from) === expectedSender;
}

function readMailboxAddress(address: Address | undefined) {
  if (!address || typeof address.address !== "string") {
    return null;
  }
  return normalizeExactSenderEmail(address.address);
}

function findPdfAttachments(parsedEmail: ParsedEmail): AttachmentLike[] {
  return (parsedEmail.attachments ?? []).filter((attachment) => {
    const contentType = (attachment.mimeType ?? "").toLowerCase();
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

async function getReceiptIngressConfig(
  env: Env,
): Promise<ReceiptIngressConfig> {
  const token = readEmailWorkerInternalToken(env);
  if (!env.API_WORKER) {
    throw new Error("API_WORKER service binding is required for receipt ingestion.");
  }
  if (!env.RECEIPT_DEDUPE) {
    throw new Error("RECEIPT_DEDUPE KV binding is required for receipt ingestion.");
  }

  let response: Response;
  try {
    response = await env.API_WORKER.fetch(
      new Request(new URL(API_RECEIPT_CONFIG_PATH, "https://api.internal"), {
        headers: {
          accept: "application/json",
          [INTERNAL_SOURCE_HEADER]: EMAIL_WORKER_SOURCE,
          [INTERNAL_TOKEN_HEADER]: token,
        },
        method: "GET",
      }),
    );
  } catch (error) {
    return await readCachedReceiptIngressConfig(env, error);
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      return await readCachedReceiptIngressConfig(
        env,
        new Error(
          `Receipt ingress configuration returned HTTP ${response.status}.`,
        ),
      );
    }
    throw new Error(
      `Receipt ingress configuration returned HTTP ${response.status}.`,
    );
  }

  const body = await readReceiptIngressConfigResponse(response);
  if (!isRecord(body) || !isRecord(body.settings)) {
    throw new Error("Receipt ingress configuration is invalid.");
  }

  const receiptToAddress = normalizeEmailValue(
    body.settings.receiptToAddress,
  );
  if (receiptToAddress !== DEFAULT_RECEIPT_TO_ADDRESS) {
    throw new Error("Receipt mailbox configuration is invalid.");
  }

  const configuredSender = body.settings.allowedSenderEmail;
  if (typeof configuredSender !== "string") {
    throw new Error("Receipt sender configuration is invalid.");
  }
  const allowedSenderEmail = normalizeExactSenderEmail(
    configuredSender,
  );
  if (!allowedSenderEmail) {
    throw new Error("Receipt sender configuration is invalid.");
  }

  const config = {
    allowedSenderEmail,
    receiptToAddress,
  };
  await cacheReceiptIngressConfig(env, config);
  return config;
}

async function cacheReceiptIngressConfig(
  env: Env,
  config: ReceiptIngressConfig,
) {
  const cachedConfig: CachedReceiptIngressConfig = {
    allowedSenderEmail: config.allowedSenderEmail,
    cachedAt: Date.now(),
    receiptToAddress: DEFAULT_RECEIPT_TO_ADDRESS,
  };
  try {
    await env.RECEIPT_DEDUPE.put(
      RECEIPT_INGRESS_CONFIG_CACHE_KEY,
      JSON.stringify(cachedConfig),
      { expirationTtl: RECEIPT_INGRESS_CONFIG_CACHE_TTL_SECONDS },
    );
  } catch (error) {
    console.error("Could not refresh the receipt ingress configuration cache.", {
      error: error instanceof Error ? error.message : "Unknown KV error.",
    });
  }
}

async function readReceiptIngressConfigResponse(
  response: Response,
): Promise<unknown> {
  if (!response.body) {
    throw new Error("Receipt ingress configuration is invalid.");
  }

  const bytes = await readStreamWithLimit(
    response.body,
    MAX_RECEIPT_INGRESS_CONFIG_RESPONSE_BYTES,
    "Receipt ingress configuration is invalid.",
  );
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Receipt ingress configuration is invalid.");
  }
}

async function readCachedReceiptIngressConfig(
  env: Env,
  liveError: unknown,
): Promise<ReceiptIngressConfig> {
  let value: string | null;
  try {
    value = await env.RECEIPT_DEDUPE.get(
      RECEIPT_INGRESS_CONFIG_CACHE_KEY,
    );
  } catch {
    throw normalizeError(liveError);
  }
  if (
    !value ||
    new TextEncoder().encode(value).byteLength >
      MAX_RECEIPT_INGRESS_CONFIG_CACHE_BYTES
  ) {
    throw normalizeError(liveError);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw normalizeError(liveError);
  }
  if (!isRecord(parsed)) {
    throw normalizeError(liveError);
  }

  const keys = Object.keys(parsed).sort();
  const expectedKeys = [
    "allowedSenderEmail",
    "cachedAt",
    "receiptToAddress",
  ];
  const allowedSenderEmail = typeof parsed.allowedSenderEmail === "string"
    ? parsed.allowedSenderEmail
    : "";
  const cachedAt = parsed.cachedAt;
  const now = Date.now();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    normalizeExactSenderEmail(allowedSenderEmail) !== allowedSenderEmail ||
    parsed.receiptToAddress !== DEFAULT_RECEIPT_TO_ADDRESS ||
    typeof cachedAt !== "number" ||
    !Number.isSafeInteger(cachedAt) ||
    cachedAt <= 0 ||
    cachedAt > now ||
    now - cachedAt > RECEIPT_INGRESS_CONFIG_CACHE_TTL_SECONDS * 1_000
  ) {
    throw normalizeError(liveError);
  }

  console.warn("Using recent cached receipt ingress configuration.", {
    cacheAgeSeconds: Math.floor((now - cachedAt) / 1_000),
  });
  return {
    allowedSenderEmail,
    receiptToAddress: DEFAULT_RECEIPT_TO_ADDRESS,
  };
}

function normalizeError(value: unknown) {
  return value instanceof Error
    ? value
    : new Error("Receipt ingress configuration is unavailable.");
}

function readEmailWorkerInternalToken(env: Env) {
  const token = env.EMAIL_WORKER_INTERNAL_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "EMAIL_WORKER_INTERNAL_TOKEN is required for email-worker-to-API calls.",
    );
  }
  return token;
}

function readDedupeTtl(env: Env) {
  const parsed = Number(env.RECEIPT_DEDUPE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_DEDUPE_TTL_SECONDS;
}

async function putReceiptQueueRecord(
  env: Env,
  key: string,
  record: ReceiptQueueRecord,
) {
  await env.RECEIPT_DEDUPE.put(key, JSON.stringify(record), {
    expirationTtl: readRetryTtl(env),
  });
}

async function queueReceiptRetry(
  env: Env,
  key: string,
  failedKey: string,
  payload: ReceiptPayload,
  payloadFingerprint: string,
  existing: ReceiptQueueRecord | null,
  nowIso: string,
  error: unknown,
) {
  const attempts = Math.max(0, existing?.attempts ?? 0) + 1;
  const errorMessage = error instanceof Error
    ? error.message
    : "Unknown receipt fulfillment error.";
  if (attempts >= RECEIPT_RETRY_MAX_ATTEMPTS) {
    await putReceiptQueueRecord(env, failedKey, {
      attempts,
      error: errorMessage,
      payload,
      payloadFingerprint,
      status: "failed",
    });
    await env.RECEIPT_DEDUPE.delete(key);
    console.error("Receipt fulfillment exhausted its retry budget.", {
      attempts,
      error: errorMessage,
      idempotencyKey: payload.idempotencyKey,
    });
    throw new Error(
      `Receipt fulfillment exhausted after ${attempts} attempts: ${errorMessage}`,
    );
  }

  const delaySeconds = Math.min(
    RECEIPT_RETRY_BASE_SECONDS * (2 ** Math.max(0, attempts - 1)),
    RECEIPT_RETRY_MAX_SECONDS,
  );
  const nextAttemptAt = new Date(
    Date.parse(nowIso) + delaySeconds * 1_000,
  ).toISOString();

  await putReceiptQueueRecord(env, key, {
    attempts,
    nextAttemptAt,
    payload,
    payloadFingerprint,
    status: "retry",
  });
  console.error("Receipt fulfillment queued for retry.", {
    attempts,
    error: errorMessage,
    idempotencyKey: payload.idempotencyKey,
    nextAttemptAt,
  });
}

async function deadLetterQueuedReceiptForSender(
  env: Env,
  retryKey: string,
  record: ReceiptQueueRecord,
) {
  if (!record.payload) {
    return;
  }

  const failedKey = `receipt-failed:${record.payload.idempotencyKey}`;
  const payloadFingerprint = record.payloadFingerprint
    ?? await createReceiptPayloadFingerprint(record.payload);
  await putReceiptQueueRecord(env, failedKey, {
    attempts: Math.max(0, record.attempts),
    error: "Queued receipt sender is missing or no longer authorized.",
    payload: record.payload,
    payloadFingerprint,
    status: "failed",
  });
  await env.RECEIPT_DEDUPE.delete(retryKey);
  console.error("Queued receipt was dead-lettered after sender policy changed.", {
    idempotencyKey: record.payload.idempotencyKey,
  });
}

function readReceiptQueueRecord(value: string | null): ReceiptQueueRecord | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.status === "fulfilled") {
      return {
        attempts: 0,
        ...(typeof parsed.payloadFingerprint === "string"
          ? { payloadFingerprint: parsed.payloadFingerprint }
          : {}),
        status: "fulfilled",
      };
    }
    if (
      parsed.status !== "failed" &&
      parsed.status !== "processing" &&
      parsed.status !== "retry"
    ) {
      return { attempts: 0, status: "fulfilled" };
    }

    return {
      attempts: typeof parsed.attempts === "number" && Number.isInteger(parsed.attempts)
        ? Math.max(0, parsed.attempts)
        : 0,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(typeof parsed.nextAttemptAt === "string"
        ? { nextAttemptAt: parsed.nextAttemptAt }
        : {}),
      ...(isReceiptPayload(parsed.payload) ? { payload: parsed.payload } : {}),
      ...(typeof parsed.payloadFingerprint === "string"
        ? { payloadFingerprint: parsed.payloadFingerprint }
        : {}),
      ...(typeof parsed.processingStartedAt === "string"
        ? { processingStartedAt: parsed.processingStartedAt }
        : {}),
      status: parsed.status,
    };
  } catch {
    // Preserve legacy dedupe values as terminal instead of risking a duplicate
    // fulfillment for a receipt completed before queue state was introduced.
    return { attempts: 0, status: "fulfilled" };
  }
}

function isReceiptPayload(value: unknown): value is ReceiptPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<Record<keyof ReceiptPayload, unknown>>;
  return (
    typeof candidate.amount === "string" &&
    typeof candidate.customerEmail === "string" &&
    typeof candidate.customerName === "string" &&
    typeof candidate.idempotencyKey === "string" &&
    (candidate.kind === "membership" || candidate.kind === "rolls" || candidate.kind === "prints") &&
    typeof candidate.orderId === "string" &&
    typeof candidate.productName === "string" &&
    typeof candidate.purchasedAt === "string" &&
    (
      candidate.sourceMessageId === undefined ||
      (
        typeof candidate.sourceMessageId === "string" &&
        candidate.sourceMessageId.length <= 255
      )
    ) &&
    (
      candidate.sourceSender === undefined ||
      (
        typeof candidate.sourceSender === "string" &&
        normalizeExactSenderEmail(candidate.sourceSender) ===
          candidate.sourceSender
      )
    ) &&
    (candidate.tier === undefined || candidate.tier === "member" || candidate.tier === "facilities")
  );
}

function isReceiptQueueRecordDue(record: ReceiptQueueRecord, nowIso: string) {
  if (record.status === "retry") {
    return !record.nextAttemptAt || record.nextAttemptAt <= nowIso;
  }
  if (record.status !== "processing" || !record.processingStartedAt) {
    return false;
  }

  const startedAt = Date.parse(record.processingStartedAt);
  return Number.isFinite(startedAt) &&
    Date.parse(nowIso) - startedAt >= RECEIPT_PROCESSING_LEASE_SECONDS * 1_000;
}

function isPermanentReceiptApiFailure(status: number) {
  return (
    status === 400 ||
    status === 409 ||
    status === 422
  );
}

function areReceiptPayloadsEqual(left: ReceiptPayload, right: ReceiptPayload) {
  return serializeReceiptPayload(left) === serializeReceiptPayload(right);
}

function serializeReceiptPayload(payload: ReceiptPayload) {
  return JSON.stringify({
    amount: payload.amount,
    customerEmail: payload.customerEmail,
    customerName: payload.customerName,
    idempotencyKey: payload.idempotencyKey,
    kind: payload.kind,
    orderId: payload.orderId,
    productName: payload.productName,
    purchasedAt: payload.purchasedAt,
    tier: payload.tier ?? null,
  });
}

async function createReceiptPayloadFingerprint(payload: ReceiptPayload) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializeReceiptPayload(payload)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function deleteReceiptQueueState(env: Env, ...keys: string[]) {
  await Promise.all(keys.map((key) => env.RECEIPT_DEDUPE.delete(key)));
}

async function cleanupReceiptQueueState(
  env: Env,
  retryKey: string,
  failedKey: string,
  payload: ReceiptPayload,
  payloadFingerprint: string,
) {
  const failed = readReceiptQueueRecord(
    await env.RECEIPT_DEDUPE.get(failedKey),
  );
  const keys = receiptQueueRecordMatchesPayload(
    failed,
    payload,
    payloadFingerprint,
  )
    ? [retryKey, failedKey]
    : [retryKey];
  await deleteReceiptQueueState(env, ...keys);
}

async function deleteMatchingReceiptFailure(
  env: Env,
  failedKey: string,
  payload: ReceiptPayload,
  payloadFingerprint: string,
) {
  const failed = readReceiptQueueRecord(
    await env.RECEIPT_DEDUPE.get(failedKey),
  );
  if (receiptQueueRecordMatchesPayload(failed, payload, payloadFingerprint)) {
    await env.RECEIPT_DEDUPE.delete(failedKey);
  }
}

function receiptQueueRecordMatchesPayload(
  record: ReceiptQueueRecord | null,
  payload: ReceiptPayload,
  payloadFingerprint: string,
) {
  if (record?.payloadFingerprint) {
    return record.payloadFingerprint === payloadFingerprint;
  }
  return !!record?.payload && areReceiptPayloadsEqual(record.payload, payload);
}

function readRetryTtl(env: Env) {
  const parsed = Number(env.RECEIPT_RETRY_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_RETRY_TTL_SECONDS;
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
  tooLargeMessage = "Receipt email is too large.",
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
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLargeMessage);
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

function normalizeEmail(value: string | undefined) {
  return (value || "").trim().toLowerCase();
}

function normalizeEmailValue(value: unknown) {
  return typeof value === "string" ? normalizeEmail(value) : "";
}

function normalizeExactSenderEmail(value: string | undefined) {
  const normalized = normalizeEmail(value);
  if (
    normalized.length > 254 ||
    normalized.includes(",") ||
    normalized.includes("*") ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeSourceMessageId(value: string | null) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized ? normalized.slice(0, 255) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(retryQueuedReceiptPayloads(env));
  },
} satisfies ExportedHandler<Env>;
