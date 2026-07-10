import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReceiptPayloads,
  parseTooCoolReceiptText,
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
      },
      {
        amount: "$-20.00",
        description: "Membership refund",
        kind: "membership",
        quantity: 1,
        tier: "member",
        totalCents: -2_000,
      },
      {
        amount: "$0.00",
        description: "Membership",
        kind: "membership",
        quantity: 1,
        tier: "member",
        totalCents: 0,
      },
      {
        amount: "$20.00",
        description: "Membership",
        kind: "membership",
        quantity: 1,
        tier: "member",
        totalCents: 2_000,
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
});
