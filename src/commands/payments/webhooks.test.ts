import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const apiMocks = vi.hoisted(() => ({
  configureStripeWebhook: vi.fn(),
  getRazorpayWebhookSetup: vi.fn(),
  rotateRazorpayWebhookSecret: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
const promptMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}));
const outputMocks = vi.hoisted(() => ({
  outputInfo: vi.fn(),
  outputJson: vi.fn(),
  outputSuccess: vi.fn(),
  outputTable: vi.fn(),
}));
const telemetryMocks = vi.hoisted(() => ({ trackPaymentUsage: vi.fn() }));
const errorMocks = vi.hoisted(() => ({ handleError: vi.fn() }));

vi.mock("../../lib/api/payments.js", () => apiMocks);
vi.mock("../../lib/credentials.js", () => authMocks);
vi.mock("../../lib/prompts.js", () => promptMocks);
vi.mock("../../lib/output.js", () => outputMocks);
vi.mock("../../lib/errors.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  handleError: errorMocks.handleError,
}));
vi.mock("./utils.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  trackPaymentUsage: telemetryMocks.trackPaymentUsage,
}));

import { registerPaymentsWebhooksCommand } from "./webhooks.js";

const webhookSetup = {
  connection: { environment: "test" },
  webhookUrl: "https://example.com/webhooks/razorpay",
  webhookSecret: "webhook_secret",
};

function makeProgram(provider: "stripe" | "razorpay"): Command {
  const program = new Command().exitOverride();
  program
    .option("--json")
    .option("--api-url <url>")
    .option("-y, --yes");
  registerPaymentsWebhooksCommand(program, provider);
  return program;
}

describe("payments webhooks commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.requireAuth.mockResolvedValue({ accessToken: "token" });
    apiMocks.configureStripeWebhook.mockResolvedValue({
      connection: { environment: "test" },
    });
    apiMocks.getRazorpayWebhookSetup.mockResolvedValue(webhookSetup);
    apiMocks.rotateRazorpayWebhookSecret.mockResolvedValue(webhookSetup);
    promptMocks.confirm.mockResolvedValue(true);
    promptMocks.isCancel.mockReturnValue(false);
    telemetryMocks.trackPaymentUsage.mockResolvedValue(undefined);
    errorMocks.handleError.mockImplementation((error: unknown) => {
      throw error;
    });
  });

  it("retrieves Razorpay webhook setup values", async () => {
    const program = makeProgram("razorpay");

    await program.parseAsync(
      ["--json", "webhooks", "setup", "--environment", "test"],
      { from: "user" },
    );

    expect(authMocks.requireAuth).toHaveBeenCalledWith(undefined);
    expect(apiMocks.getRazorpayWebhookSetup).toHaveBeenCalledWith("test");
    expect(outputMocks.outputJson).toHaveBeenCalledWith(webhookSetup);
    expect(telemetryMocks.trackPaymentUsage).toHaveBeenCalledWith(
      "webhooks.setup",
      true,
      { provider: "razorpay", environment: "test" },
    );
  });

  it("rotates the Razorpay webhook secret with --yes", async () => {
    const program = makeProgram("razorpay");

    await program.parseAsync(
      [
        "--json",
        "--yes",
        "webhooks",
        "rotate-secret",
        "--environment",
        "live",
      ],
      { from: "user" },
    );

    expect(promptMocks.confirm).not.toHaveBeenCalled();
    expect(apiMocks.rotateRazorpayWebhookSecret).toHaveBeenCalledWith("live");
    expect(outputMocks.outputJson).toHaveBeenCalledWith(webhookSetup);
    expect(telemetryMocks.trackPaymentUsage).toHaveBeenCalledWith(
      "webhooks.rotate-secret",
      true,
      { provider: "razorpay", environment: "live" },
    );
  });

  it("prompts before rotating and prints the new setup values", async () => {
    const program = makeProgram("razorpay");

    await program.parseAsync(
      ["webhooks", "rotate-secret", "--environment", "test"],
      { from: "user" },
    );

    expect(promptMocks.confirm).toHaveBeenCalledWith({
      message:
        "Rotate the Razorpay test webhook secret? Existing webhook deliveries will fail until the new secret is updated in Razorpay Dashboard.",
    });
    expect(outputMocks.outputTable).toHaveBeenCalledWith(
      ["Env", "Webhook URL", "Webhook Secret"],
      [["test", webhookSetup.webhookUrl, webhookSetup.webhookSecret]],
    );
    expect(outputMocks.outputSuccess).toHaveBeenCalledWith(
      "Razorpay test webhook secret rotated.",
    );
    expect(outputMocks.outputInfo).toHaveBeenCalledWith(
      "Update the secret in Razorpay Dashboard before webhook deliveries resume.",
    );
  });

  it("does not rotate when confirmation is declined", async () => {
    promptMocks.confirm.mockResolvedValue(false);
    const program = makeProgram("razorpay");

    await program.parseAsync(
      ["webhooks", "rotate-secret", "--environment", "test"],
      { from: "user" },
    );

    expect(apiMocks.rotateRazorpayWebhookSecret).not.toHaveBeenCalled();
    expect(outputMocks.outputInfo).toHaveBeenCalledWith("Cancelled.");
  });

  it("requires --yes for JSON secret rotation", async () => {
    const program = makeProgram("razorpay");

    await expect(
      program.parseAsync(
        [
          "--json",
          "webhooks",
          "rotate-secret",
          "--environment",
          "test",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow(
      "Use --yes with --json to rotate the Razorpay webhook secret non-interactively.",
    );

    expect(apiMocks.rotateRazorpayWebhookSecret).not.toHaveBeenCalled();
    expect(authMocks.requireAuth).not.toHaveBeenCalled();
    expect(telemetryMocks.trackPaymentUsage).toHaveBeenCalledWith(
      "webhooks.rotate-secret",
      false,
      { provider: "razorpay", environment: "test" },
      expect.any(Error),
    );
  });

  it("rejects invalid Razorpay environments before calling the API", async () => {
    const program = makeProgram("razorpay");

    await expect(
      program.parseAsync(
        ["--json", "webhooks", "setup", "--environment", "staging"],
        { from: "user" },
      ),
    ).rejects.toThrow('Environment must be "test" or "live".');

    expect(authMocks.requireAuth).not.toHaveBeenCalled();
    expect(apiMocks.getRazorpayWebhookSetup).not.toHaveBeenCalled();
  });

  it("keeps the Stripe configure command unchanged", async () => {
    const program = makeProgram("stripe");

    await program.parseAsync(
      ["--json", "webhooks", "configure", "--environment", "test"],
      { from: "user" },
    );

    expect(apiMocks.configureStripeWebhook).toHaveBeenCalledWith("test");
    expect(outputMocks.outputJson).toHaveBeenCalled();
    expect(telemetryMocks.trackPaymentUsage).toHaveBeenCalledWith(
      "webhooks.configure",
      true,
      { provider: "stripe", environment: "test" },
    );
  });
});
