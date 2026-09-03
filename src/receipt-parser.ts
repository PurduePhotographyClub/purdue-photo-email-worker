const MAX_MEMBERSHIP_UNITS_PER_LINE = 25;
const MAX_SUPPORTED_RECEIPT_LINES = 50;
const MAX_FULFILLMENT_PAYLOADS_PER_ATTACHMENT = 50;
const MAX_CUSTOMER_EMAIL_LENGTH = 254;
const MAX_RECEIPT_BODY_CHARS = 256 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOOCOOL_CONFIRMATION_LABEL = "attention: toocool order confirmation";

type ReceiptKind = "membership" | "rolls" | "prints";
type MembershipTier = "member" | "facilities";

interface TooCoolLineItem {
  amount: string;
  description: string;
  kind: ReceiptKind | null;
  quantity: number;
  tier: MembershipTier | null;
  totalCents: number;
  unitAmount: string;
  unitPriceCents: number;
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
  sourceMessageId?: string;
  sourceSender?: string;
  tier?: MembershipTier;
}

interface TooCoolEmailContent {
  html?: string;
  text?: string;
}

interface TooCoolEmailRecord {
  customerEmail: string;
  orderId: string;
}

export function parseTooCoolReceiptText(text: string): TooCoolReceipt {
  const normalizedText = normalizePdfText(text);
  const lines = splitNonEmptyLines(normalizedText);

  const orderId = readOrderId(normalizedText, lines);
  const customerId = readCustomerId(normalizedText, lines, orderId).toLowerCase();
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

export function extractTooCoolCustomerEmail(
  content: TooCoolEmailContent,
  expectedOrderId?: string,
): string {
  const bodies = [
    content.text,
    content.html ? readableHtmlText(content.html) : undefined,
  ].filter((body): body is string => typeof body === "string" && body.length > 0);
  const records = bodies.flatMap(readTooCoolEmailRecords);
  if (records.length === 0) {
    throw new Error("Missing TooCOOL customer email in message body.");
  }
  const matchingRecords = expectedOrderId
    ? records.filter((record) => record.orderId === expectedOrderId)
    : records;
  if (matchingRecords.length === 0) {
    throw new Error(
      "Message body does not contain a customer email for the matching TooCOOL order.",
    );
  }

  const normalized = matchingRecords.map((record) =>
    normalizeCustomerEmail(record.customerEmail)
  );
  if (normalized.some((candidate) => candidate === null)) {
    throw new Error("TooCOOL customer email must be a valid email address.");
  }

  const unique = [...new Set(normalized.filter((candidate): candidate is string =>
    candidate !== null
  ))];
  if (unique.length !== 1) {
    throw new Error("TooCOOL message body contains multiple customer emails.");
  }
  return unique[0];
}

export function buildReceiptPayloads(
  receipt: TooCoolReceipt,
  customerEmailValue: string,
): ReceiptPayload[] {
  const customerEmail = normalizeCustomerEmail(customerEmailValue);
  if (!customerEmail) {
    throw new Error("TooCOOL customer email must be a valid email address.");
  }

  const initial: {
    occurrences: Record<string, number>;
    payloads: ReceiptPayload[];
  } = { occurrences: {}, payloads: [] };
  const supportedItems = receipt.lineItems.filter((item) =>
    item.kind && isFulfillableReceiptLineItem(
      item.quantity,
      item.totalCents,
      item.unitPriceCents,
    ));
  if (supportedItems.length > MAX_SUPPORTED_RECEIPT_LINES) {
    throw new Error("Receipt contains too many supported line items.");
  }
  const payloadCount = supportedItems.reduce(
    (total, item) => total + (item.kind === "membership" ? item.quantity : 1),
    0,
  );
  if (payloadCount > MAX_FULFILLMENT_PAYLOADS_PER_ATTACHMENT) {
    throw new Error("Receipt contains too many fulfillment items.");
  }

  return receipt.lineItems.reduce((state, item) => {
    if (
      !item.kind ||
      !isFulfillableReceiptLineItem(
        item.quantity,
        item.totalCents,
        item.unitPriceCents,
      )
    ) {
      return state;
    }
    const kind = item.kind;

    if (
      kind === "membership" &&
      item.quantity > MAX_MEMBERSHIP_UNITS_PER_LINE
    ) {
      throw new Error("Membership receipt quantity is too large to fulfill safely.");
    }

    const baseKey = createIdempotencyKey(receipt.orderId, item);
    const occurrence = (state.occurrences[baseKey] ?? 0) + 1;
    const unitCount = kind === "membership" ? item.quantity : 1;
    const itemPayloads = Array.from({ length: unitCount }, (_, index) => {
      const unit = index + 1;
      const lineSuffix = occurrence > 1 ? `:line:${occurrence}` : "";
      const unitSuffix = unit > 1 ? `:unit:${unit}` : "";
      return {
        amount: kind === "membership" ? item.unitAmount : item.amount,
        customerEmail,
        customerName: receipt.customerName,
        idempotencyKey: `${baseKey}${lineSuffix}${unitSuffix}`,
        kind,
        orderId: receipt.orderId,
        productName: item.quantity > 1
          ? kind === "membership"
            ? `${item.description} (unit ${unit} of ${item.quantity})`
            : `${item.description} (quantity ${item.quantity})`
          : item.description,
        purchasedAt: receipt.purchasedAt,
        ...(kind === "membership" && item.tier ? { tier: item.tier } : {}),
      } satisfies ReceiptPayload;
    });

    return {
      occurrences: {
        ...state.occurrences,
        [baseKey]: occurrence,
      },
      payloads: [...state.payloads, ...itemPayloads],
    };
  }, initial).payloads;
}

function normalizePdfText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function readableHtmlText(html: string) {
  assertReceiptBodySize(html);
  const lowerHtml = html.toLowerCase();
  const text: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      text.push(html.slice(cursor));
      break;
    }
    text.push(html.slice(cursor, tagStart), " ");
    const tagEnd = html.indexOf(">", tagStart + 1);
    if (tagEnd < 0) {
      break;
    }

    const tagName = /^\/?\s*([a-z0-9]+)/i.exec(
      html.slice(tagStart + 1, tagEnd),
    )?.[1]?.toLowerCase();
    const isClosingTag = /^\s*\//.test(html.slice(tagStart + 1, tagEnd));
    if (!isClosingTag && (tagName === "script" || tagName === "style")) {
      const closingStart = lowerHtml.indexOf(`</${tagName}`, tagEnd + 1);
      if (closingStart < 0) {
        break;
      }
      const closingEnd = html.indexOf(">", closingStart + tagName.length + 2);
      cursor = closingEnd < 0 ? html.length : closingEnd + 1;
      continue;
    }
    cursor = tagEnd + 1;
  }

  return text.join("")
    .replace(/&#(?:0*64|x0*40);/gi, "@")
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function readTooCoolEmailRecords(body: string): TooCoolEmailRecord[] {
  assertReceiptBodySize(body);
  const normalized = body.replace(/\s+/g, " ").trim();
  const searchable = normalized.toLowerCase();
  const records: TooCoolEmailRecord[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const confirmationIndex = searchable.indexOf(
      TOOCOOL_CONFIRMATION_LABEL,
      cursor,
    );
    if (confirmationIndex < 0) {
      break;
    }
    const nextConfirmationIndex = searchable.indexOf(
      TOOCOOL_CONFIRMATION_LABEL,
      confirmationIndex + TOOCOOL_CONFIRMATION_LABEL.length,
    );
    const blockEnd = nextConfirmationIndex < 0
      ? normalized.length
      : nextConfirmationIndex;
    const record = readTooCoolEmailRecord(
      normalized.slice(confirmationIndex, blockEnd),
    );
    if (record) {
      records.push(record);
    }
    cursor = confirmationIndex + TOOCOOL_CONFIRMATION_LABEL.length;
  }
  return records;
}

function readTooCoolEmailRecord(block: string): TooCoolEmailRecord | null {
  const searchable = block.toLowerCase();
  const customerIndex = searchable.indexOf("customer:");
  const orderDateIndex = searchable.indexOf("order date:", customerIndex + 9);
  const shippingIndex = searchable.indexOf("shipping name:", orderDateIndex + 11);
  const orderNumberIndex = searchable.indexOf("order number:", shippingIndex + 14);
  const emailIndex = searchable.indexOf("email:", orderNumberIndex + 13);
  if (
    customerIndex < 0 ||
    orderDateIndex < 0 ||
    shippingIndex < 0 ||
    orderNumberIndex < 0 ||
    emailIndex < 0
  ) {
    return null;
  }

  const customerName = block.slice(customerIndex + 9, orderDateIndex).trim();
  const orderDate = block.slice(orderDateIndex + 11, shippingIndex).trim();
  const shippingName = block.slice(shippingIndex + 14, orderNumberIndex).trim();
  const orderId = block.slice(orderNumberIndex + 13, emailIndex).trim();
  if (
    customerName.length === 0 || customerName.length > 200 ||
    orderDate.length === 0 || orderDate.length > 80 ||
    shippingName.length === 0 || shippingName.length > 200 ||
    !/^\d{4,}$/.test(orderId)
  ) {
    return null;
  }

  const customerEmail = /^\s*([^\s<>"']{1,300})/.exec(
    block.slice(emailIndex + 6),
  )?.[1];
  return customerEmail ? { customerEmail, orderId } : null;
}

function assertReceiptBodySize(body: string) {
  if (body.length > MAX_RECEIPT_BODY_CHARS) {
    throw new Error("TooCOOL message body is too large.");
  }
}

function normalizeCustomerEmail(value: string | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CUSTOMER_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
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

function readCustomerId(text: string, lines: string[], orderId: string) {
  const inline = normalizePurdueCustomerId(
    readInlineLabelValue(text, "Customer ID") ?? "",
  );
  if (inline) {
    return inline;
  }

  const orderIdIndex = lines.findIndex((line) => line === orderId);
  const orderDateIndex = lines.findIndex((line, index) =>
    index > orderIdIndex && /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(line));
  const value = normalizePurdueCustomerId(lines[orderDateIndex + 1] ?? "");
  if (orderDateIndex < 0 || !value) {
    throw new Error("Missing TooCOOL customer id.");
  }
  return value;
}

function normalizePurdueCustomerId(value: string) {
  const normalized = value.toLowerCase().trim();
  const emailMatch = /^([a-z0-9._-]{2,40})@(?:purdue\.edu|purdu)$/.exec(normalized);
  if (emailMatch?.[1]) {
    return emailMatch[1];
  }
  return /^[a-z0-9._-]{2,40}$/.test(normalized) ? normalized : null;
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

  const customerIdIndex = lines.findIndex((line) =>
    normalizePurdueCustomerId(line) === customerId.toLowerCase()
  );
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

    const quantity = Number(lines[index]);
    const description = normalizeDescription(tail.slice(0, firstMoneyIndex).join(" "));
    const unitPriceCents = moneyToCents(moneyValues[0]);
    const totalCents = moneyToCents(moneyValues[3]);
    if (!isFulfillableReceiptLineItem(quantity, totalCents, unitPriceCents)) {
      continue;
    }
    const classification = classifyLineItem(description, unitPriceCents);
    items.push({
      amount: formatMoney(totalCents),
      description,
      kind: classification.kind,
      quantity,
      tier: classification.tier,
      totalCents,
      unitAmount: formatMoney(unitPriceCents),
      unitPriceCents,
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
  const unitPriceCents = moneyToCents(match[3]);
  const totalCents = moneyToCents(match[6]);
  if (!isFulfillableReceiptLineItem(quantity, totalCents, unitPriceCents)) {
    return null;
  }
  const classification = classifyLineItem(description, unitPriceCents);

  return {
    amount: formatMoney(totalCents),
    description,
    kind: classification.kind,
    quantity,
    tier: classification.tier,
    totalCents,
    unitAmount: formatMoney(unitPriceCents),
    unitPriceCents,
  };
}

function normalizeDescription(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 140);
}

function classifyLineItem(
  description: string,
  unitPriceCents: number,
): { kind: ReceiptKind | null; tier: MembershipTier | null } {
  const normalized = description.toLowerCase();
  if (/\bfacilit(?:y|ies)\b/.test(normalized)) {
    return { kind: "membership", tier: "facilities" };
  }
  if (/\b(member|membership|dues)\b/.test(normalized)) {
    return {
      kind: "membership",
      tier: normalized.includes("facilit") || unitPriceCents >= 3000 ? "facilities" : "member",
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

function isFulfillableReceiptLineItem(
  quantity: number,
  totalCents: number,
  unitPriceCents: number,
) {
  return (
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    Number.isSafeInteger(totalCents) &&
    totalCents > 0 &&
    Number.isSafeInteger(unitPriceCents) &&
    unitPriceCents > 0
  );
}

function isMoney(value: string) {
  return /^-?\d+(?:\.\d{2})$/.test(value);
}

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
