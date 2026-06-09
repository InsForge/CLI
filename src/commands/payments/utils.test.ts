import { beforeEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({
  getProjectConfig: vi.fn(() => ({
    project_id: "p1",
    project_name: "Test Project",
    org_id: "o1",
    region: "us",
  })),
}));
vi.mock("../../lib/config.js", () => configMock);

const analyticsMock = vi.hoisted(() => ({
  trackPayments: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));
vi.mock("../../lib/analytics.js", () => analyticsMock);

import { CLIError } from "../../lib/errors.js";
import { trackPaymentUsage } from "./utils.js";

describe("payment command telemetry", () => {
  beforeEach(() => {
    analyticsMock.trackPayments.mockClear();
    analyticsMock.shutdownAnalytics.mockClear();
    configMock.getProjectConfig.mockReturnValue({
      project_id: "p1",
      project_name: "Test Project",
      org_id: "o1",
      region: "us",
    });
  });

  it("includes provider and structured error fields for failed payment commands", async () => {
    const error = new CLIError(
      `${"failed ".repeat(100)}done`,
      5,
      "PAYMENT_ERROR",
      502,
    );

    await trackPaymentUsage(
      "sync",
      false,
      { provider: "razorpay", environment: "test" },
      error,
    );

    expect(analyticsMock.trackPayments).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({ project_id: "p1" }),
      expect.objectContaining({
        success: false,
        provider: "razorpay",
        environment: "test",
        error_name: "CLIError",
        error_code: "PAYMENT_ERROR",
        exit_code: 5,
        status_code: 502,
      }),
    );

    const properties = analyticsMock.trackPayments.mock.calls[0]?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(properties?.error_message).toMatch(/^failed failed/);
    expect(String(properties?.error_message).length).toBeLessThanOrEqual(503);
    expect(analyticsMock.shutdownAnalytics).toHaveBeenCalledOnce();
  });
});
