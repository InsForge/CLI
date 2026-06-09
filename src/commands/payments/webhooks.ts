import type { Command } from "commander";
import { configureStripeWebhook } from "../../lib/api/payments.js";
import { requireAuth } from "../../lib/credentials.js";
import { getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputSuccess, outputTable } from "../../lib/output.js";
import { formatDate, parseEnvironment, trackPaymentUsage } from "./utils.js";

export function registerPaymentsWebhooksCommand(paymentsCmd: Command): void {
  const webhooksCmd = paymentsCmd
    .command("webhooks")
    .description("Manage Stripe webhooks");

  webhooksCmd
    .command("configure")
    .description("Create or recreate the managed Stripe webhook endpoint")
    .requiredOption(
      "--environment <environment>",
      "Stripe environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

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
