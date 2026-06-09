import type { Command } from "commander";
import {
  syncRazorpayPayments,
  syncStripePayments,
} from "../../lib/api/payments.js";
import type { PaymentProvider } from "@insforge/shared-schemas";
import { requireAuth } from "../../lib/credentials.js";
import { getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputSuccess, outputTable } from "../../lib/output.js";
import {
  formatDate,
  parseEnvironmentOrAll,
  trackPaymentUsage,
} from "./utils.js";

export function registerPaymentsSyncCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  paymentsCmd
    .command("sync")
    .description("Sync configured payment provider data")
    .option(
      "--environment <environment>",
      "Payment environment: test, live, or all",
      "all",
    )
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironmentOrAll(opts.environment);
        await requireAuth();

        if (provider === "stripe") {
          const data = await syncStripePayments(environment);

          if (json) {
            outputJson(data);
          } else if (data.results.length === 0) {
            console.log("No configured Stripe environments to sync.");
          } else {
            outputTable(
              [
                "Env",
                "Status",
                "Products",
                "Prices",
                "Customers",
                "Subscriptions",
                "Unmapped",
                "Synced At",
              ],
              data.results.map((result) => [
                result.environment,
                result.connection.lastSyncStatus ?? result.connection.status,
                String(result.connection.lastSyncCounts.products ?? 0),
                String(result.connection.lastSyncCounts.prices ?? 0),
                String(result.connection.lastSyncCounts.customers ?? 0),
                String(result.subscriptions?.synced ?? 0),
                String(result.subscriptions?.unmapped ?? 0),
                formatDate(result.connection.lastSyncedAt),
              ]),
            );
            outputSuccess("Stripe payments synced.");
          }
        } else {
          const data = await syncRazorpayPayments(environment);

          if (json) {
            outputJson(data);
          } else if (data.results.length === 0) {
            console.log("No configured Razorpay environments to sync.");
          } else {
            outputTable(
              [
                "Env",
                "Status",
                "Items",
                "Plans",
                "Customers",
                "Subscriptions",
                "Invoices",
                "Payments",
                "Synced At",
              ],
              data.results.map((result) => [
                result.environment,
                result.status,
                String(result.syncCounts.items),
                String(result.syncCounts.plans),
                String(result.syncCounts.customers),
                String(result.syncCounts.subscriptions),
                String(result.syncCounts.invoices),
                String(result.syncCounts.payments),
                formatDate(result.connection.lastSyncedAt),
              ]),
            );
            outputSuccess("Razorpay payments synced.");
          }
        }

        await trackPaymentUsage("sync", true, { provider, environment });
      } catch (err) {
        await trackPaymentUsage(
          "sync",
          false,
          {
            provider,
            environment: opts.environment,
          },
          err,
        );
        handleError(err, json);
      }
    });
}
