import assert from "node:assert/strict";
import test from "node:test";
import emailWorker, {
  buildReceiptPayloads,
  parseTooCoolReceiptText,
  processReceiptPayload,
  processReceiptPayloadBatch,
  processReceiptPayloadGroups,
  retryQueuedReceiptPayloads,
} from "./index.ts";

function createReceipt(lineItems) {
  return {
    customerId: "jdoe42",
    customerName: "Jane Doe",
    lineItems,
    orderId: "12345",
    purchasedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createReceiptText(lineItem) {
  return [
    "Order: 12345",
    "Customer ID: jdoe42",
    "Jane Doe Order Date: 1 Jan 2026",
    "Quantity Description Price Discount Tax Total",
    lineItem,
    "PAID",
  ].join("\n");
}

function createStackedReceiptText(quantity, description, moneyValues) {
  return [
    "Order: 12345",
    "Customer ID: jdoe42",
    "Jane Doe Order Date: 1 Jan 2026",
    String(quantity),
    description,
    ...moneyValues,
    "PAID",
  ].join("\n");
}

function createPayload(overrides = {}) {
  return {
    amount: "$20.00",
    customerEmail: "jdoe42@purdue.edu",
    customerName: "Jane Doe",
    idempotencyKey: "toocool:12345:rolls:film:2000",
    kind: "rolls",
    orderId: "12345",
    productName: "Film rolls",
    purchasedAt: "2026-01-01T00:00:00.000Z",
    sourceSender: "trusted.sender@example.com",
    ...overrides,
  };
}

function createTestEnv(fetchImpl, { handleConfig = true } = {}) {
  const stored = new Map();
  const putOptions = new Map();
  return {
    env: {
      API_WORKER: {
        async fetch(input) {
          const request = input instanceof Request ? input : new Request(input);
          if (
            handleConfig &&
            request.method === "GET" &&
            new URL(request.url).pathname === "/internal/receipts/config"
          ) {
            return Response.json({
              settings: {
                allowedSenderEmail: "trusted.sender@example.com",
                receiptToAddress: "purchases@purduephotoclub.org",
              },
            });
          }
          return await fetchImpl(input);
        },
      },
      EMAIL_WORKER_INTERNAL_TOKEN: "test-token",
      RECEIPT_DEDUPE: {
        async delete(key) {
          stored.delete(key);
          putOptions.delete(key);
        },
        async get(key) {
          return stored.get(key) ?? null;
        },
        async list({ prefix }) {
          return {
            keys: Array.from(stored.keys())
              .filter((name) => name.startsWith(prefix))
              .map((name) => ({ name })),
            list_complete: true,
          };
        },
        async put(key, value, options) {
          stored.set(key, value);
          putOptions.set(key, options);
        },
      },
    },
    putOptions,
    stored,
  };
}

function createPdfWithText(lines) {
  const escapePdfText = (value) => value.replace(/([\\()])/g, "\\$1");
  const stream = [
    "BT /F1 12 Tf 72 720 Td",
    ...lines.map((line, index) =>
      `${index === 0 ? "" : "0 -18 Td "}(${escapePdfText(line)}) Tj`),
    "ET",
  ].join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  ].join("\n");

  return Buffer.from(pdf);
}

function createReceiptMimeEmail({
  fromHeader = "Trusted Sender <trusted.sender@example.com>",
} = {}) {
  const pdf = createPdfWithText([
    "Order: 12345",
    "Customer ID: jdoe42",
    "Jane Doe Order Date: 1 Jan 2026",
    "Quantity Description Price Discount Tax Total",
    "1 Membership 20.00 20.00 0.00 20.00",
    "PAID",
  ]);
  const boundary = "receipt-test-boundary";
  const fromHeaders = Array.isArray(fromHeader)
    ? fromHeader.map((value) => `From: ${value}`)
    : [`From: ${fromHeader}`];
  return Buffer.from([
    ...fromHeaders,
    "To: purchases@purduephotoclub.org",
    "Message-ID: <receipt-123@example.com>",
    "Subject: Purchase receipt",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Receipt attached.",
    `--${boundary}`,
    'Content-Type: application/pdf; name="receipt.pdf"',
    'Content-Disposition: attachment; filename="receipt.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    pdf.toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n"));
}

function createEmailMessage({
  from = "trusted.sender@example.com",
  messageId = "<receipt-123@example.com>",
  raw = createReceiptMimeEmail(),
  rawSize = raw.byteLength,
  to = "purchases@purduephotoclub.org",
} = {}) {
  const rejections = [];
  const rawBytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return {
    message: {
      from,
      headers: new Headers({ "message-id": messageId }),
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(rawBytes);
          controller.close();
        },
      }),
      rawSize,
      setReject(reason) {
        rejections.push(reason);
      },
      to,
    },
    rejections,
  };
}

function createIngressEnv(fetchImpl, overrides = {}) {
  const { env, putOptions, stored } = createTestEnv(fetchImpl, {
    handleConfig: false,
  });
  return {
    env: {
      ...env,
      RECEIPT_TO_ADDRESS: "purchases@purduephotoclub.org",
      ...overrides,
    },
    putOptions,
    stored,
  };
}

async function runEmailHandler(message, env) {
  await emailWorker.email(message, env, {
    passThroughOnException() {},
    waitUntil() {},
  });
}

test("does not build fulfillment payloads for non-positive totals or quantities", () => {
  const payloads = buildReceiptPayloads(
    createReceipt([
      {
        amount: "$20.00",
        description: "Membership",
        kind: "membership",
        quantity: 0,
        tier: "member",
        totalCents: 2_000,
        unitAmount: "$20.00",
        unitPriceCents: 2_000,
      },
      {
        amount: "$-20.00",
        description: "Membership refund",
        kind: "membership",
        quantity: 1,
        tier: "member",
        totalCents: -2_000,
        unitAmount: "$-20.00",
        unitPriceCents: -2_000,
      },
      {
        amount: "$0.00",
        description: "Membership",
        kind: "membership",
        quantity: 1,
        tier: "member",
        totalCents: 0,
        unitAmount: "$0.00",
        unitPriceCents: 0,
      },
      {
        amount: "$20.00",
        description: "Membership",
        kind: "membership",
        quantity: 1,
        tier: "member",
        totalCents: 2_000,
        unitAmount: "$20.00",
        unitPriceCents: 2_000,
      },
    ]),
  );

  assert.deepEqual(payloads, [
    {
      amount: "$20.00",
      customerEmail: "jdoe42@purdue.edu",
      customerName: "Jane Doe",
      idempotencyKey: "toocool:12345:membership:membership:2000",
      kind: "membership",
      orderId: "12345",
      productName: "Membership",
      purchasedAt: "2026-01-01T00:00:00.000Z",
      tier: "member",
    },
  ]);
});

test("preserves the legacy first key while distinguishing repeated lines and membership units", () => {
  const payloads = buildReceiptPayloads(
    createReceipt([
      {
        amount: "$40.00",
        description: "Membership",
        kind: "membership",
        quantity: 2,
        tier: "member",
        totalCents: 4_000,
        unitAmount: "$20.00",
        unitPriceCents: 2_000,
      },
      {
        amount: "$20.00",
        description: "Membership",
        kind: "membership",
        quantity: 1,
        tier: "member",
        totalCents: 4_000,
        unitAmount: "$40.00",
        unitPriceCents: 4_000,
      },
    ]),
  );

  assert.deepEqual(
    payloads.map((payload) => payload.idempotencyKey),
    [
      "toocool:12345:membership:membership:4000",
      "toocool:12345:membership:membership:4000:unit:2",
      "toocool:12345:membership:membership:4000:line:2",
    ],
  );
});

test("multi-quantity basic memberships use unit pricing and member-tier keys", () => {
  const payloads = buildReceiptPayloads(
    parseTooCoolReceiptText(
      createReceiptText("3 Membership 10.00 30.00 0.00 30.00"),
    ),
  );

  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads.map((payload) => payload.tier), [
    "member",
    "member",
    "member",
  ]);
  assert.deepEqual(payloads.map((payload) => payload.amount), [
    "$10.00",
    "$10.00",
    "$10.00",
  ]);
});

test("rejects parsed receipt lines with an invalid quantity or total before classification", () => {
  assert.throws(
    () => parseTooCoolReceiptText(
      createReceiptText("0 Membership 20.00 20.00 0.00 20.00"),
    ),
    /does not contain any supported line items/,
  );
  assert.throws(
    () => parseTooCoolReceiptText(
      createReceiptText("1 Membership Refund -20.00 -20.00 0.00 -20.00"),
    ),
    /does not contain any supported line items/,
  );
  assert.throws(
    () => parseTooCoolReceiptText(
      createReceiptText("1 Membership -10.00 10.00 0.00 10.00"),
    ),
    /does not contain any supported line items/,
  );
});

test("rejects invalid stacked receipt lines before classification", () => {
  assert.throws(
    () => parseTooCoolReceiptText(
      createStackedReceiptText(0, "Membership", [
        "20.00",
        "20.00",
        "0.00",
        "20.00",
      ]),
    ),
    /does not contain any supported line items/,
  );
  assert.throws(
    () => parseTooCoolReceiptText(
      createStackedReceiptText(1, "Membership", [
        "-10.00",
        "10.00",
        "0.00",
        "10.00",
      ]),
    ),
    /does not contain any supported line items/,
  );
});

test("bounds supported receipt lines and total fulfillment payloads", () => {
  const printItem = {
    amount: "$1.00",
    description: "Print order",
    kind: "prints",
    quantity: 1,
    tier: null,
    totalCents: 100,
    unitAmount: "$1.00",
    unitPriceCents: 100,
  };
  assert.throws(
    () => buildReceiptPayloads(createReceipt(
      Array.from({ length: 51 }, (_, index) => ({
        ...printItem,
        description: `Print order ${index + 1}`,
      })),
    )),
    /too many supported line items/,
  );

  const membershipItem = {
    amount: "$200.00",
    description: "Membership",
    kind: "membership",
    quantity: 20,
    tier: "member",
    totalCents: 20_000,
    unitAmount: "$10.00",
    unitPriceCents: 1_000,
  };
  assert.throws(
    () => buildReceiptPayloads(createReceipt([
      membershipItem,
      { ...membershipItem, description: "Membership dues" },
      { ...membershipItem, description: "Basic membership" },
    ])),
    /too many fulfillment items/,
  );
});

test("queues a receipt after transport failure and retries it durably", async () => {
  const stored = new Map();
  let apiCalls = 0;
  const env = {
    API_WORKER: {
      async fetch(input) {
        const request = input instanceof Request ? input : new Request(input);
        if (
          request.method === "GET" &&
          new URL(request.url).pathname === "/internal/receipts/config"
        ) {
          return Response.json({
            settings: {
              allowedSenderEmail: "trusted.sender@example.com",
              receiptToAddress: "purchases@purduephotoclub.org",
            },
          });
        }
        apiCalls += 1;
        if (apiCalls === 1) {
          throw new Error("transport unavailable");
        }
        return Response.json({ success: true });
      },
    },
    EMAIL_WORKER_INTERNAL_TOKEN: "test-token",
    RECEIPT_DEDUPE: {
      async delete(key) {
        stored.delete(key);
      },
      async get(key) {
        return stored.get(key) ?? null;
      },
      async list({ prefix }) {
        return {
          keys: Array.from(stored.keys())
            .filter((name) => name.startsWith(prefix))
            .map((name) => ({ name })),
          list_complete: true,
        };
      },
      async put(key, value) {
        stored.set(key, value);
      },
    },
  };
  const payload = {
    amount: "$20.00",
    customerEmail: "jdoe42@purdue.edu",
    customerName: "Jane Doe",
    idempotencyKey: "toocool:12345:rolls:film:2000",
    kind: "rolls",
    orderId: "12345",
    productName: "Film rolls",
    purchasedAt: "2026-01-01T00:00:00.000Z",
    sourceSender: "trusted.sender@example.com",
  };

  const queued = await processReceiptPayload(env, payload);
  const retryState = JSON.parse(
    stored.get(`receipt-retry:${payload.idempotencyKey}`),
  );
  const retry = await retryQueuedReceiptPayloads(
    env,
    new Date(Date.parse(retryState.nextAttemptAt) + 1).toISOString(),
  );

  assert.equal(apiCalls, 2);
  assert.deepEqual(queued, { duplicate: false, queued: true, status: 202 });
  assert.deepEqual(retry, { failed: 0, retried: 1, scanned: 1, succeeded: 1 });
  assert.equal(
    JSON.parse(stored.get(`receipt:${payload.idempotencyKey}`)).status,
    "fulfilled",
  );
  assert.equal(stored.has(`receipt-retry:${payload.idempotencyKey}`), false);
});

test("a fresh processing lease remains queued instead of being acknowledged as fulfilled", async () => {
  const stored = new Map();
  let apiCalls = 0;
  const env = {
    API_WORKER: {
      async fetch() {
        apiCalls += 1;
        return Response.json({ success: true });
      },
    },
    EMAIL_WORKER_INTERNAL_TOKEN: "test-token",
    RECEIPT_DEDUPE: {
      async delete(key) {
        stored.delete(key);
      },
      async get(key) {
        return stored.get(key) ?? null;
      },
      async list() {
        return { keys: [], list_complete: true };
      },
      async put(key, value) {
        stored.set(key, value);
      },
    },
  };
  const payload = {
    amount: "$20.00",
    customerEmail: "jdoe42@purdue.edu",
    customerName: "Jane Doe",
    idempotencyKey: "toocool:12345:rolls:film:2000",
    kind: "rolls",
    orderId: "12345",
    productName: "Film rolls",
    purchasedAt: "2026-01-01T00:00:00.000Z",
  };
  stored.set(
    `receipt-retry:${payload.idempotencyKey}`,
    JSON.stringify({
      attempts: 0,
      payload,
      processingStartedAt: new Date().toISOString(),
      status: "processing",
    }),
  );

  const result = await processReceiptPayload(env, payload);

  assert.deepEqual(result, { duplicate: false, queued: true, status: 202 });
  assert.equal(apiCalls, 0);
});

test("permanent API failures move to a dead-letter prefix outside the retry scan", async () => {
  for (const status of [400, 409, 422]) {
    const { env, stored } = createTestEnv(async () =>
      Response.json({ error: "permanent" }, { status }));
    const payload = createPayload({
      idempotencyKey: `toocool:12345:rolls:film:${status}`,
    });

    await assert.rejects(processReceiptPayload(env, payload), new RegExp(`HTTP ${status}`));

    const failedKey = `receipt-failed:${payload.idempotencyKey}`;
    const deadLetter = JSON.parse(stored.get(failedKey));
    assert.equal(deadLetter.status, "failed");
    assert.deepEqual(deadLetter.payload, payload);
    assert.equal(stored.has(`receipt-retry:${payload.idempotencyKey}`), false);

    const retry = await retryQueuedReceiptPayloads(env);
    assert.deepEqual(retry, { failed: 0, retried: 0, scanned: 0, succeeded: 0 });
  }
});

test("auth and route failures enter the bounded retry queue with exponential backoff", async () => {
  for (const status of [401, 403, 404]) {
    const { env, stored } = createTestEnv(async () =>
      Response.json({ error: "operational" }, { status }));
    const payload = createPayload({
      idempotencyKey: `toocool:12345:rolls:film:${status}`,
    });
    const firstAttemptAt = "2026-07-24T12:00:00.000Z";

    assert.deepEqual(
      await processReceiptPayload(env, payload, firstAttemptAt),
      { duplicate: false, queued: true, status: 202 },
    );
    const firstRetry = JSON.parse(
      stored.get(`receipt-retry:${payload.idempotencyKey}`),
    );
    assert.equal(firstRetry.attempts, 1);
    assert.equal(firstRetry.nextAttemptAt, "2026-07-24T12:05:00.000Z");
    assert.equal(stored.has(`receipt-failed:${payload.idempotencyKey}`), false);

    await retryQueuedReceiptPayloads(env, "2026-07-24T12:05:00.001Z");
    const secondRetry = JSON.parse(
      stored.get(`receipt-retry:${payload.idempotencyKey}`),
    );
    assert.equal(secondRetry.attempts, 2);
    assert.equal(secondRetry.nextAttemptAt, "2026-07-24T12:15:00.001Z");
    assert.equal(stored.has(`receipt-failed:${payload.idempotencyKey}`), false);
  }
});

test("retryable API failures dead-letter after five total attempts", async () => {
  let apiCalls = 0;
  const { env, stored } = createTestEnv(async () => {
    apiCalls += 1;
    return Response.json({ error: "authorization unavailable" }, { status: 401 });
  });
  const payload = createPayload({
    idempotencyKey: "toocool:12345:rolls:film:bounded-auth-retry",
  });

  assert.deepEqual(
    await processReceiptPayload(env, payload, "2026-07-24T12:00:00.000Z"),
    { duplicate: false, queued: true, status: 202 },
  );

  let finalRetryResult = null;
  while (stored.has(`receipt-retry:${payload.idempotencyKey}`)) {
    const retryState = JSON.parse(
      stored.get(`receipt-retry:${payload.idempotencyKey}`),
    );
    finalRetryResult = await retryQueuedReceiptPayloads(
      env,
      new Date(Date.parse(retryState.nextAttemptAt) + 1).toISOString(),
    );
  }

  const deadLetter = JSON.parse(
    stored.get(`receipt-failed:${payload.idempotencyKey}`),
  );
  assert.equal(apiCalls, 5);
  assert.equal(deadLetter.attempts, 5);
  assert.equal(deadLetter.status, "failed");
  assert.deepEqual(deadLetter.payload, payload);
  assert.equal(stored.has(`receipt-retry:${payload.idempotencyKey}`), false);
  assert.deepEqual(finalRetryResult, {
    failed: 1,
    retried: 1,
    scanned: 1,
    succeeded: 0,
  });
});

test("scheduled retries load sender policy once and dead-letter revoked or missing senders", async () => {
  const calls = [];
  const { env, stored } = createTestEnv(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ success: true });
  }, {
    handleConfig: false,
  });
  env.API_WORKER = {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === "/internal/receipts/config"
      ) {
        return Response.json({
          settings: {
            allowedSenderEmail: "trusted.sender@example.com",
            receiptToAddress: "purchases@purduephotoclub.org",
          },
        });
      }
      return Response.json({ success: true });
    },
  };

  const payloads = [
    createPayload({ idempotencyKey: "receipt-authorized" }),
    createPayload({
      idempotencyKey: "receipt-revoked",
      sourceSender: "former.sender@example.com",
    }),
    createPayload({
      idempotencyKey: "receipt-missing-sender",
      sourceSender: undefined,
    }),
  ];
  for (const payload of payloads) {
    stored.set(`receipt-retry:${payload.idempotencyKey}`, JSON.stringify({
      attempts: 1,
      nextAttemptAt: "2026-07-24T12:00:00.000Z",
      payload,
      status: "retry",
    }));
  }

  const result = await retryQueuedReceiptPayloads(
    env,
    "2026-07-24T12:00:00.001Z",
  );

  assert.deepEqual(result, {
    failed: 2,
    retried: 1,
    scanned: 3,
    succeeded: 1,
  });
  assert.deepEqual(calls, [
    "GET /internal/receipts/config",
    "POST /internal/receipts",
  ]);
  assert.equal(stored.has("receipt:receipt-authorized"), true);
  for (const idempotencyKey of ["receipt-revoked", "receipt-missing-sender"]) {
    assert.equal(stored.has(`receipt-retry:${idempotencyKey}`), false);
    const failed = JSON.parse(
      stored.get(`receipt-failed:${idempotencyKey}`),
    );
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /sender/i);
  }
});

test("an authorized redelivery refreshes queued sender metadata before the retry is due", async () => {
  let postCalls = 0;
  const { env, stored } = createTestEnv(async () => {
    postCalls += 1;
    return postCalls === 1
      ? Response.json({ error: "unavailable" }, { status: 503 })
      : Response.json({ success: true });
  });
  const originalPayload = createPayload({
    idempotencyKey: "sender-refresh",
    sourceMessageId: "<old-message@example.com>",
    sourceSender: "former.sender@example.com",
  });
  const refreshedPayload = {
    ...originalPayload,
    sourceMessageId: "<new-message@example.com>",
    sourceSender: "trusted.sender@example.com",
  };

  assert.deepEqual(
    await processReceiptPayload(
      env,
      originalPayload,
      "2026-07-24T12:00:00.000Z",
    ),
    { duplicate: false, queued: true, status: 202 },
  );
  assert.deepEqual(
    await processReceiptPayload(
      env,
      refreshedPayload,
      "2026-07-24T12:01:00.000Z",
    ),
    { duplicate: false, queued: true, status: 202 },
  );

  const retryKey = `receipt-retry:${originalPayload.idempotencyKey}`;
  const queued = JSON.parse(stored.get(retryKey));
  assert.equal(postCalls, 1);
  assert.equal(queued.payload.sourceSender, "trusted.sender@example.com");
  assert.equal(queued.payload.sourceMessageId, "<new-message@example.com>");

  assert.deepEqual(
    await retryQueuedReceiptPayloads(
      env,
      new Date(Date.parse(queued.nextAttemptAt) + 1).toISOString(),
    ),
    { failed: 0, retried: 1, scanned: 1, succeeded: 1 },
  );
  assert.equal(postCalls, 2);
  assert.equal(stored.has("receipt:sender-refresh"), true);
});

test("scheduled retries leave the queue untouched when sender policy cannot be resolved", async () => {
  let postCalls = 0;
  const { env, stored } = createTestEnv(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/internal/receipts/config"
    ) {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    postCalls += 1;
    return Response.json({ success: true });
  }, {
    handleConfig: false,
  });
  const payload = createPayload({ idempotencyKey: "policy-unavailable" });
  const retryKey = `receipt-retry:${payload.idempotencyKey}`;
  const retryRecord = {
    attempts: 1,
    nextAttemptAt: "2026-07-24T12:00:00.000Z",
    payload,
    status: "retry",
  };
  stored.set(retryKey, JSON.stringify(retryRecord));

  await assert.rejects(
    retryQueuedReceiptPayloads(env, "2026-07-24T12:00:00.001Z"),
    /HTTP 503/,
  );

  assert.equal(postCalls, 0);
  assert.deepEqual(JSON.parse(stored.get(retryKey)), retryRecord);
  assert.equal(
    stored.has(`receipt-failed:${payload.idempotencyKey}`),
    false,
  );
});

test("terminal dedupe fingerprints reject changed payloads and clean stale queue state", async () => {
  let apiCalls = 0;
  const { env, stored } = createTestEnv(async () => {
    apiCalls += 1;
    return Response.json({ success: true });
  });
  const payload = createPayload();
  const retryKey = `receipt-retry:${payload.idempotencyKey}`;
  const failedKey = `receipt-failed:${payload.idempotencyKey}`;

  await processReceiptPayload(env, payload);
  const terminal = JSON.parse(stored.get(`receipt:${payload.idempotencyKey}`));
  assert.match(terminal.payloadFingerprint, /^[a-f0-9]{64}$/);

  stored.set(retryKey, JSON.stringify({ attempts: 1, payload, status: "retry" }));
  stored.set(failedKey, JSON.stringify({ attempts: 1, payload, status: "failed" }));
  assert.deepEqual(await processReceiptPayload(env, payload), {
    duplicate: true,
    status: 200,
  });
  assert.equal(stored.has(retryKey), false);
  assert.equal(stored.has(failedKey), false);

  await assert.rejects(
    processReceiptPayload(env, { ...payload, customerName: "Changed Name" }),
    /conflicts with completed fulfillment state/,
  );
  assert.equal(apiCalls, 1);
  const conflict = JSON.parse(stored.get(failedKey));
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.payload.customerName, "Changed Name");

  assert.deepEqual(await processReceiptPayload(env, payload), {
    duplicate: true,
    status: 200,
  });
  assert.deepEqual(JSON.parse(stored.get(failedKey)), conflict);
});

test("payload batches continue after a permanent line failure and aggregate errors", async () => {
  const attempted = [];
  const { env, stored } = createTestEnv(async (request) => {
    const payload = await request.json();
    attempted.push(payload.idempotencyKey);
    return payload.idempotencyKey.endsWith(":first")
      ? Response.json({ error: "conflict" }, { status: 409 })
      : Response.json({ success: true });
  });
  const payloads = [
    createPayload({ idempotencyKey: "toocool:12345:rolls:first" }),
    createPayload({ idempotencyKey: "toocool:12345:rolls:second" }),
    createPayload({ idempotencyKey: "toocool:12345:rolls:third" }),
  ];

  await assert.rejects(
    processReceiptPayloadBatch(env, payloads),
    (error) => error instanceof AggregateError && error.errors.length === 1,
  );

  assert.deepEqual(attempted, payloads.map((payload) => payload.idempotencyKey));
  assert.equal(stored.has("receipt-failed:toocool:12345:rolls:first"), true);
  assert.equal(stored.has("receipt:toocool:12345:rolls:second"), true);
  assert.equal(stored.has("receipt:toocool:12345:rolls:third"), true);
});

test("whole-email payload caps are checked before any attachment group dispatches", async () => {
  let apiCalls = 0;
  const { env } = createTestEnv(async () => {
    apiCalls += 1;
    return Response.json({ success: true });
  });
  const firstAttachment = Array.from({ length: 30 }, (_, index) =>
    createPayload({ idempotencyKey: `toocool:12345:rolls:first-${index}` }));
  const secondAttachment = Array.from({ length: 21 }, (_, index) =>
    createPayload({ idempotencyKey: `toocool:12345:rolls:second-${index}` }));

  await assert.rejects(
    processReceiptPayloadGroups(env, [firstAttachment, secondAttachment]),
    /too many fulfillment items across attachments/,
  );
  assert.equal(apiCalls, 0);
});

test("email ingress does not accept the legacy shared internal token", async () => {
  let apiCalls = 0;
  const { env } = createIngressEnv(async () => {
    apiCalls += 1;
    return Response.json({ success: true });
  });
  delete env.EMAIL_WORKER_INTERNAL_TOKEN;
  env.INTERNAL_TOKEN = "legacy-shared-token";
  const { message, rejections } = createEmailMessage();

  await runEmailHandler(message, env);

  assert.equal(apiCalls, 0);
  assert.deepEqual(rejections, ["Receipt processing failed."]);
});

test("email ingress loads the dashboard sender config and forwards source metadata", async () => {
  const calls = [];
  const { env, putOptions, stored } = createIngressEnv(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const pathname = new URL(request.url).pathname;
    const body = request.method === "POST"
      ? await request.clone().json()
      : null;
    calls.push({
      body,
      headers: Object.fromEntries(request.headers),
      method: request.method,
      pathname,
    });

    if (pathname === "/internal/receipts/config") {
      return Response.json({
        settings: {
          allowedSenderEmail: "trusted.sender@example.com",
          receiptToAddress: "purchases@purduephotoclub.org",
        },
      });
    }
    return Response.json({ success: true });
  });
  const { message, rejections } = createEmailMessage({
    from: "  TRUSTED.SENDER@EXAMPLE.COM ",
  });

  await runEmailHandler(message, env);

  assert.deepEqual(rejections, []);
  assert.deepEqual(
    calls.map(({ method, pathname }) => `${method} ${pathname}`),
    [
      "GET /internal/receipts/config",
      "POST /internal/receipts",
    ],
  );
  assert.equal(
    calls[0].headers["x-pcc-internal-source"],
    "email-worker",
  );
  assert.equal(calls[0].headers["x-internal-token"], "test-token");
  assert.equal(calls[1].headers["x-internal-token"], "test-token");
  assert.equal(
    calls[1].body.sourceSender,
    "trusted.sender@example.com",
  );
  assert.equal(
    calls[1].body.sourceMessageId,
    "<receipt-123@example.com>",
  );
  const cachedConfig = JSON.parse(stored.get("receipt-ingress-config:v1"));
  assert.deepEqual(
    {
      allowedSenderEmail: cachedConfig.allowedSenderEmail,
      receiptToAddress: cachedConfig.receiptToAddress,
    },
    {
      allowedSenderEmail: "trusted.sender@example.com",
      receiptToAddress: "purchases@purduephotoclub.org",
    },
  );
  assert.equal(typeof cachedConfig.cachedAt, "number");
  assert.deepEqual(Object.keys(cachedConfig).sort(), [
    "allowedSenderEmail",
    "cachedAt",
    "receiptToAddress",
  ]);
  assert.deepEqual(putOptions.get("receipt-ingress-config:v1"), {
    expirationTtl: 15 * 60,
  });
});

test("email ingress requires one RFC 5322 From mailbox matching the envelope sender", async () => {
  const invalidFromHeaders = [
    "Other Sender <other.sender@example.com>",
    "Trusted Sender <trusted.sender@example.com>, Other Sender <other.sender@example.com>",
    "Team: trusted.sender@example.com;",
    [],
    [
      "Trusted Sender <trusted.sender@example.com>",
      "Other Sender <other.sender@example.com>",
    ],
  ];

  for (const fromHeader of invalidFromHeaders) {
    const calls = [];
    const { env } = createIngressEnv(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const pathname = new URL(request.url).pathname;
      calls.push(`${request.method} ${pathname}`);
      if (pathname === "/internal/receipts/config") {
        return Response.json({
          settings: {
            allowedSenderEmail: "trusted.sender@example.com",
            receiptToAddress: "purchases@purduephotoclub.org",
          },
        });
      }
      return Response.json({ success: true });
    });
    const raw = createReceiptMimeEmail({ fromHeader });
    const { message, rejections } = createEmailMessage({ raw });

    await runEmailHandler(message, env);

    assert.deepEqual(rejections, [
      "Receipt From header does not match sender.",
    ]);
    assert.deepEqual(calls, ["GET /internal/receipts/config"]);
  }
});

test("email ingress uses a fresh last-known-good config only for transient config outages", async () => {
  for (const transientFailure of ["network", 429, 503]) {
    const calls = [];
    const { env, stored } = createIngressEnv(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const pathname = new URL(request.url).pathname;
      calls.push(`${request.method} ${pathname}`);
      if (pathname === "/internal/receipts/config") {
        if (transientFailure === "network") {
          throw new Error("service binding unavailable");
        }
        return Response.json(
          { error: "temporarily unavailable" },
          { status: transientFailure },
        );
      }
      return Response.json({ success: true });
    });
    stored.set("receipt-ingress-config:v1", JSON.stringify({
      allowedSenderEmail: "trusted.sender@example.com",
      cachedAt: Date.now(),
      receiptToAddress: "purchases@purduephotoclub.org",
    }));
    const { message, rejections } = createEmailMessage();

    await runEmailHandler(message, env);

    assert.deepEqual(rejections, []);
    assert.deepEqual(calls, [
      "GET /internal/receipts/config",
      "POST /internal/receipts",
    ]);
  }
});

test("email ingress fails closed for stale or invalid cached config", async () => {
  const invalidCachedConfigs = [
    {
      allowedSenderEmail: "trusted.sender@example.com",
      cachedAt: Date.now() - 15 * 60 * 1_000 - 1,
      receiptToAddress: "purchases@purduephotoclub.org",
    },
    {
      allowedSenderEmail: "*@example.com",
      cachedAt: Date.now(),
      receiptToAddress: "purchases@purduephotoclub.org",
    },
    {
      allowedSenderEmail: "trusted.sender@example.com",
      cachedAt: Date.now(),
      receiptToAddress: "other@example.com",
    },
    {
      allowedSenderEmail: "trusted.sender@example.com",
      cachedAt: Date.now(),
      extra: "not allowed",
      receiptToAddress: "purchases@purduephotoclub.org",
    },
    {
      allowedSenderEmail: "trusted.sender@example.com",
      cachedAt: Date.now() + 60_000,
      receiptToAddress: "purchases@purduephotoclub.org",
    },
  ];

  for (const cachedConfig of invalidCachedConfigs) {
    let rawRead = false;
    const { env, stored } = createIngressEnv(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }));
    stored.set("receipt-ingress-config:v1", JSON.stringify(cachedConfig));
    const rejections = [];
    const message = {
      from: "trusted.sender@example.com",
      headers: new Headers({ "message-id": "<cache-fail-closed@example.com>" }),
      raw: {
        getReader() {
          rawRead = true;
          throw new Error("Invalid cache must fail before MIME parsing.");
        },
      },
      rawSize: 1,
      setReject(reason) {
        rejections.push(reason);
      },
      to: "purchases@purduephotoclub.org",
    };

    await runEmailHandler(message, env);

    assert.deepEqual(rejections, ["Receipt processing failed."]);
    assert.equal(rawRead, false);
  }
});

test("email ingress never uses cache for config auth, route, or live validation failures", async () => {
  const failures = [
    401,
    403,
    404,
    "oversized",
    {
      settings: {
        allowedSenderEmail: "*@example.com",
        receiptToAddress: "purchases@purduephotoclub.org",
      },
    },
    {
      settings: {
        allowedSenderEmail: "trusted.sender@example.com",
        receiptToAddress: "other@example.com",
      },
    },
  ];

  for (const failure of failures) {
    let rawRead = false;
    const { env, stored } = createIngressEnv(async () => {
      if (typeof failure === "number") {
        return Response.json({ error: "not available" }, { status: failure });
      }
      if (failure === "oversized") {
        return new Response(
          `${" ".repeat(4_097)}${JSON.stringify({
            settings: {
              allowedSenderEmail: "trusted.sender@example.com",
              receiptToAddress: "purchases@purduephotoclub.org",
            },
          })}`,
          { headers: { "content-type": "application/json" } },
        );
      }
      return Response.json(failure);
    });
    stored.set("receipt-ingress-config:v1", JSON.stringify({
      allowedSenderEmail: "trusted.sender@example.com",
      cachedAt: Date.now(),
      receiptToAddress: "purchases@purduephotoclub.org",
    }));
    const rejections = [];
    const message = {
      from: "trusted.sender@example.com",
      headers: new Headers({ "message-id": "<no-cache-bypass@example.com>" }),
      raw: {
        getReader() {
          rawRead = true;
          throw new Error("Non-transient config failure must fail before MIME parsing.");
        },
      },
      rawSize: 1,
      setReject(reason) {
        rejections.push(reason);
      },
      to: "purchases@purduephotoclub.org",
    };

    await runEmailHandler(message, env);

    assert.deepEqual(rejections, ["Receipt processing failed."]);
    assert.equal(rawRead, false);
  }
});

test("email ingress rejects wildcard and multiple-sender dashboard configurations before reading MIME", async () => {
  for (const allowedSenderEmail of [
    "*@example.com",
    "first@example.com,second@example.com",
  ]) {
    let rawRead = false;
    const { env } = createIngressEnv(async () =>
      Response.json({
        settings: {
          allowedSenderEmail,
          receiptToAddress: "purchases@purduephotoclub.org",
        },
      }));
    const rejections = [];
    const message = {
      from: "trusted.sender@example.com",
      headers: new Headers({
        "message-id": "<receipt-invalid-config@example.com>",
      }),
      raw: {
        getReader() {
          rawRead = true;
          throw new Error("MIME must not be read for invalid sender config.");
        },
      },
      rawSize: 1,
      setReject(reason) {
        rejections.push(reason);
      },
      to: "purchases@purduephotoclub.org",
    };

    await runEmailHandler(message, env);

    assert.deepEqual(rejections, ["Receipt processing failed."]);
    assert.equal(rawRead, false);
  }
});

test("email ingress requires the purchases mailbox even when a legacy env value differs", async () => {
  let rawRead = false;
  const calls = [];
  const rateLimitKeys = [];
  const { env } = createIngressEnv(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({
      settings: {
        allowedSenderEmail: "trusted.sender@example.com",
        receiptToAddress: "purchases@purduephotoclub.org",
      },
    });
  }, {
    EMAIL_WORKER_RATE_LIMITER: {
      async limit({ key }) {
        rateLimitKeys.push(key);
        return { success: true };
      },
    },
    RECEIPT_TO_ADDRESS: "other@example.com",
  });
  const rejections = [];
  const message = {
    from: "trusted.sender@example.com",
    headers: new Headers({ "message-id": "<wrong-mailbox@example.com>" }),
    raw: {
      getReader() {
        rawRead = true;
        throw new Error("MIME must not be read for the wrong mailbox.");
      },
    },
    rawSize: 1,
    setReject(reason) {
      rejections.push(reason);
    },
    to: "other@example.com",
  };

  await runEmailHandler(message, env);

  assert.deepEqual(calls, []);
  assert.deepEqual(rateLimitKeys, []);
  assert.deepEqual(rejections, ["Unexpected receipt mailbox."]);
  assert.equal(rawRead, false);
});

test("email ingress rejects declared raw sizes above 10 MiB without buffering the message", async () => {
  let rawRead = false;
  const calls = [];
  const rateLimitKeys = [];
  const { env } = createIngressEnv(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({
      settings: {
        allowedSenderEmail: "trusted.sender@example.com",
        receiptToAddress: "purchases@purduephotoclub.org",
      },
    });
  }, {
    EMAIL_WORKER_RATE_LIMITER: {
      async limit({ key }) {
        rateLimitKeys.push(key);
        return { success: true };
      },
    },
  });
  const rejections = [];
  const message = {
    from: "trusted.sender@example.com",
    headers: new Headers({ "message-id": "<oversize@example.com>" }),
    raw: {
      getReader() {
        rawRead = true;
        throw new Error("Oversize email must not be buffered.");
      },
    },
    rawSize: 10 * 1024 * 1024 + 1,
    setReject(reason) {
      rejections.push(reason);
    },
    to: "purchases@purduephotoclub.org",
  };

  await runEmailHandler(message, env);

  assert.deepEqual(calls, []);
  assert.deepEqual(rateLimitKeys, []);
  assert.deepEqual(rejections, ["Receipt processing failed."]);
  assert.equal(rawRead, false);
});

test("email ingress rate limits the envelope sender before loading dashboard config", async () => {
  const calls = [];
  const rateLimitKeys = [];
  let rawRead = false;
  const { env } = createIngressEnv(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({
      settings: {
        allowedSenderEmail: "trusted.sender@example.com",
        receiptToAddress: "purchases@purduephotoclub.org",
      },
    });
  }, {
    EMAIL_WORKER_RATE_LIMITER: {
      async limit({ key }) {
        rateLimitKeys.push(key);
        return { success: false };
      },
    },
  });
  const rejections = [];
  const message = {
    from: "  TRUSTED.SENDER@EXAMPLE.COM ",
    headers: new Headers({ "message-id": "<rate-limited@example.com>" }),
    raw: {
      getReader() {
        rawRead = true;
        throw new Error("Rate-limited email must not be buffered.");
      },
    },
    rawSize: 1,
    setReject(reason) {
      rejections.push(reason);
    },
    to: "purchases@purduephotoclub.org",
  };

  await runEmailHandler(message, env);

  assert.deepEqual(calls, []);
  assert.deepEqual(rateLimitKeys, ["email:trusted.sender@example.com"]);
  assert.deepEqual(rejections, ["Too many receipt emails."]);
  assert.equal(rawRead, false);
});

test("email ingress fails closed when the dashboard sender setting is null", async () => {
  const calls = [];
  let rawRead = false;
  const { env } = createIngressEnv(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const pathname = new URL(request.url).pathname;
    calls.push(`${request.method} ${pathname}`);
    if (pathname === "/internal/receipts/config") {
      return Response.json({
        settings: {
          allowedSenderEmail: null,
          receiptToAddress: "purchases@purduephotoclub.org",
        },
      });
    }
    return Response.json({ success: true });
  });
  const rejections = [];
  const message = {
    from: "trusted.sender@example.com",
    headers: new Headers({ "message-id": "<null-sender@example.com>" }),
    raw: {
      getReader() {
        rawRead = true;
        throw new Error("Null sender config must fail before MIME parsing.");
      },
    },
    rawSize: 1,
    setReject(reason) {
      rejections.push(reason);
    },
    to: "purchases@purduephotoclub.org",
  };

  await runEmailHandler(message, env);

  assert.deepEqual(rejections, ["Receipt processing failed."]);
  assert.deepEqual(calls, ["GET /internal/receipts/config"]);
  assert.equal(rawRead, false);
});
