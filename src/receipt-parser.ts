const MAX_MEMBERSHIP_UNITS_PER_LINE = 25;
const MAX_SUPPORTED_RECEIPT_LINES = 50;
const MAX_FULFILLMENT_PAYLOADS_PER_ATTACHMENT = 50;
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
