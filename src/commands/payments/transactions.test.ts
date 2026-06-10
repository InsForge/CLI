import { describe, expect, it } from "vitest";
import { getTransactionTimestamp } from "./transactions.js";

type TransactionInput = Parameters<typeof getTransactionTimestamp>[0];

function transaction(
  overrides: Record<string, unknown> = {},
): TransactionInput {
  return {
    type: "payment",
    status: "paid",
    amount: 1000,
    amountRefunded: 0,
    currency: "usd",
    providerCustomerId: "cus_123",
    customerEmailSnapshot: null,
    providerReferenceType: "payment_intent",
    providerReferenceId: "pi_123",
    subjectType: "team",
    subjectId: "team_123",
    paidAt: "2026-01-01T00:00:00.000Z",
    failedAt: null,
    refundedAt: null,
    providerCreatedAt: "2025-12-31T00:00:00.000Z",
    createdAt: "2025-12-30T00:00:00.000Z",
    ...overrides,
  } as TransactionInput;
}

describe("getTransactionTimestamp", () => {
  it("prefers refund time for refunded transactions", () => {
    expect(
      getTransactionTimestamp(
        transaction({
          status: "refunded",
          refundedAt: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("prefers failure time for failed transactions", () => {
    expect(
      getTransactionTimestamp(
        transaction({
          status: "failed",
          failedAt: "2026-01-03T00:00:00.000Z",
        }),
      ),
    ).toBe("2026-01-03T00:00:00.000Z");
  });

  it("uses paid time for non-refund successful transactions", () => {
    expect(getTransactionTimestamp(transaction({ status: "paid" }))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});
