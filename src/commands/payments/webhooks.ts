import type { Command } from "commander";
import type {
  GetRazorpayWebhookSetupResponse,
  PaymentProvider,
} from "@insforge/shared-schemas";
import * as prompts from "../../lib/prompts.js";
import {
  configureStripeWebhook,
  getRazorpayWebhookSetup,
  rotateRazorpayWebhookSecret,
} from "../../lib/api/payments.js";
import { requireAuth } from "../../lib/credentials.js";
import { CLIError, getRootOpts, handleError } from "../../lib/errors.js";
import {
  outputInfo,
  outputJson,
  outputSuccess,
  outputTable,
} from "../../lib/output.js";
import { formatDate, parseEnvironment, trackPaymentUsage } from "./utils.js";

export function registerPaymentsWebhooksCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  const providerLabel = provider === "stripe" ? "Stripe" : "Razorpay";
  const webhooksCmd = paymentsCmd
    .command("webhooks")
    .description(`Manage ${providerLabel} webhooks`);

  if (provider === "stripe") {
    registerStripeWebhookConfigureCommand(webhooksCmd);
  } else {
    registerRazorpayWebhookCommands(webhooksCmd);
  }
}

function registerStripeWebhookConfigureCommand(webhooksCmd: Command): void {
  webhooksCmd
    .command("configure")
    .description("Create or recreate the managed Stripe webhook endpoint")
    .requiredOption(
      "--environment <environment>",
      "Stripe environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth(apiUrl);

        const data = await configureStripeWebhook(environment);

        if (json) {
          outputJson(data);
        } else {
          outputTable(
            ["Env", "Webhook ID", "URL", "Configured At"],
            [
              [
                data.connection.environment,
                data.connection.webhookEndpointId ?? "-",
                data.connection.webhookEndpointUrl ?? "-",
                formatDate(data.connection.webhookConfiguredAt),
              ],
            ],
          );
          outputSuccess(`Stripe ${environment} webhook configured.`);
        }

        await trackPaymentUsage("webhooks.configure", true, {
          provider: "stripe",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "webhooks.configure",
          false,
          {
            provider: "stripe",
            environment: opts.environment,
          },
          err,
        );
        handleError(err, json);
      }
    });
}

function outputRazorpayWebhookSetup(
  data: GetRazorpayWebhookSetupResponse,
): void {
  outputTable(
    ["Env", "Webhook URL", "Webhook Secret"],
    [[data.connection.environment, data.webhookUrl, data.webhookSecret]],
  );
}

function registerRazorpayWebhookCommands(webhooksCmd: Command): void {
  webhooksCmd
    .command("setup")
    .description("Show the URL and secret for manual Razorpay webhook setup")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth(apiUrl);

        const data = await getRazorpayWebhookSetup(environment);

        if (json) {
          outputJson(data);
        } else {
          outputRazorpayWebhookSetup(data);
        }

        await trackPaymentUsage("webhooks.setup", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "webhooks.setup",
          false,
          {
            provider: "razorpay",
            environment: opts.environment,
          },
          err,
        );
        handleError(err, json);
      }
    });

  webhooksCmd
    .command("rotate-secret")
    .description("Rotate the Razorpay webhook secret")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json, yes, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);

        if (json && !yes) {
          throw new CLIError(
            "Use --yes with --json to rotate the Razorpay webhook secret non-interactively.",
          );
        }

        await requireAuth(apiUrl);

        if (!yes) {
          const confirm = await prompts.confirm({
            message: `Rotate the Razorpay ${environment} webhook secret? Existing webhook deliveries will fail until the new secret is updated in Razorpay Dashboard.`,
          });
          if (prompts.isCancel(confirm) || !confirm) {
            outputInfo("Cancelled.");
            return;
          }
        }

        const data = await rotateRazorpayWebhookSecret(environment);

        if (json) {
          outputJson(data);
        } else {
          outputRazorpayWebhookSetup(data);
          outputSuccess(`Razorpay ${environment} webhook secret rotated.`);
          outputInfo(
            "Update the secret in Razorpay Dashboard before webhook deliveries resume.",
          );
        }

        await trackPaymentUsage("webhooks.rotate-secret", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "webhooks.rotate-secret",
          false,
          {
            provider: "razorpay",
            environment: opts.environment,
          },
          err,
        );
        handleError(err, json);
      }
    });
}
