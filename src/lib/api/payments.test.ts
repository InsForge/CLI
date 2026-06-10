import { beforeEach, describe, expect, it, vi } from "vitest";

const ossFetchMock = vi.hoisted(() => vi.fn());
vi.mock("./oss.js", () => ({
  ossFetch: ossFetchMock,
}));

import {
  createRazorpayItem,
  createRazorpayPlan,
  createStripePrice,
  getStripeProduct,
  getStripePaymentsStatus,
  listPaymentTransactions,
  listRazorpayCatalog,
  listStripePrices,
  syncRazorpayPayments,
  syncStripePayments,
  updateRazorpayItem,
} from "./payments.js";

function mockJsonResponse(value: unknown = {}): Response {
  return {
    json: async () => value,
  } as Response;
}

describe("payments API client", () => {
  beforeEach(() => {
    ossFetchMock.mockReset();
    ossFetchMock.mockResolvedValue(mockJsonResponse());
  });

  it("builds provider status and sync paths", async () => {
    await getStripePaymentsStatus();
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/stripe/status",
    );

    await syncStripePayments("live");
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/stripe/live/sync",
      { method: "POST" },
    );

    await syncRazorpayPayments();
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/razorpay/sync",
      { method: "POST" },
    );
  });

  it("builds provider environment catalog paths", async () => {
    await listRazorpayCatalog("test");
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/razorpay/test/catalog",
    );

    await listStripePrices("live", "prod_123");
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/stripe/live/catalog/prices?productId=prod_123",
    );
  });

  it("encodes path segments for resource operations", async () => {
    await getStripeProduct("test", "prod/with space");
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/stripe/test/catalog/products/prod%2Fwith%20space",
    );

    await updateRazorpayItem("live", "item/with space", { active: false });
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/razorpay/live/catalog/items/item%2Fwith%20space",
      {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
      },
    );
  });

  it("sends mutation methods and JSON bodies", async () => {
    await createStripePrice("test", {
      productId: "prod_123",
      currency: "usd",
      unitAmount: 1000,
    });
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/stripe/test/catalog/prices",
      {
        method: "POST",
        body: JSON.stringify({
          productId: "prod_123",
          currency: "usd",
          unitAmount: 1000,
        }),
      },
    );

    await createRazorpayItem("test", {
      name: "Pro",
      amount: 200000,
      currency: "inr",
    });
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/razorpay/test/catalog/items",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Pro",
          amount: 200000,
          currency: "inr",
        }),
      },
    );

    await createRazorpayPlan("test", {
      period: "monthly",
      interval: 1,
      item: {
        name: "Pro",
        amount: 200000,
        currency: "inr",
      },
    });
    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/razorpay/test/catalog/plans",
      {
        method: "POST",
        body: JSON.stringify({
          period: "monthly",
          interval: 1,
          item: {
            name: "Pro",
            amount: 200000,
            currency: "inr",
          },
        }),
      },
    );
  });

  it("builds provider-scoped transaction query paths", async () => {
    await listPaymentTransactions("stripe", "live", {
      limit: 20,
      subjectType: "team",
      subjectId: "team 123",
    });

    expect(ossFetchMock).toHaveBeenLastCalledWith(
      "/api/payments/stripe/live/transactions?limit=20&subjectType=team&subjectId=team+123",
    );
  });
});
