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
import {
  nullableString,
  parseRequiredIntegerOption,
  parseRequiredRazorpayPlanPeriod,
  trackPaymentUsage,
} from "./utils.js";

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

  it("includes provider and structured error fields without raw messages", async () => {
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
    expect(properties).not.toHaveProperty("error_message");
    expect(analyticsMock.shutdownAnalytics).toHaveBeenCalledOnce();
  });

  it("does not send raw invalid environment telemetry", async () => {
    await trackPaymentUsage(
      "sync",
      false,
      { provider: "stripe", environment: "prod free text" },
      new Error("user entered free text"),
    );

    const properties = analyticsMock.trackPayments.mock.calls[0]?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(properties).toEqual(
      expect.objectContaining({
        success: false,
        provider: "stripe",
        environment_valid: false,
        error_name: "Error",
      }),
    );
    expect(properties).not.toHaveProperty("environment");
    expect(properties).not.toHaveProperty("error_message");
  });
});

describe("payment command parsers", () => {
  it("normalizes nullable strings", () => {
    expect(nullableString(undefined)).toBeUndefined();
    expect(nullableString("null")).toBeNull();
    expect(nullableString("value")).toBe("value");
  });

  it("parses required integer options without defaulting missing values", () => {
    expect(parseRequiredIntegerOption("0", "--amount", { min: 0 })).toBe(0);
    expect(() => parseRequiredIntegerOption(undefined, "--amount")).toThrow(
      "Provide --amount.",
    );
  });

  it("parses required Razorpay plan periods", () => {
    expect(parseRequiredRazorpayPlanPeriod("monthly")).toBe("monthly");
    expect(() => parseRequiredRazorpayPlanPeriod(undefined)).toThrow(
      "Provide --period.",
    );
  });
});
