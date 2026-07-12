import assert from "node:assert/strict";
import test from "node:test";
import {
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
    ...overrides,
  };
}

function createTestEnv(fetchImpl) {
  const stored = new Map();
  return {
    env: {
      API_WORKER: { fetch: fetchImpl },
      INTERNAL_TOKEN: "test-token",
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
    },
    stored,
  };
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
      async fetch() {
        apiCalls += 1;
        if (apiCalls === 1) {
          throw new Error("transport unavailable");
        }
        return Response.json({ success: true });
      },
    },
    INTERNAL_TOKEN: "test-token",
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
    INTERNAL_TOKEN: "test-token",
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

test("operational auth and route failures stay in the retry queue", async () => {
  for (const status of [401, 403, 404]) {
    const { env, stored } = createTestEnv(async () =>
      Response.json({ error: "operational" }, { status }));
    const payload = createPayload({
      idempotencyKey: `toocool:12345:rolls:film:${status}`,
    });

    assert.deepEqual(await processReceiptPayload(env, payload), {
      duplicate: false,
      queued: true,
      status: 202,
    });
    const retry = JSON.parse(
      stored.get(`receipt-retry:${payload.idempotencyKey}`),
    );
    assert.equal(retry.status, "retry");
    assert.equal(stored.has(`receipt-failed:${payload.idempotencyKey}`), false);
  }
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
