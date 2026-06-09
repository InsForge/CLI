import type { Command } from "commander";
import {
  getRazorpayPaymentsStatus,
  getStripePaymentsStatus,
} from "../../lib/api/payments.js";
import type { PaymentProvider } from "@insforge/shared-schemas";
import { requireAuth } from "../../lib/credentials.js";
import { getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputTable } from "../../lib/output.js";
import { formatDate, trackPaymentUsage } from "./utils.js";

export function registerPaymentsStatusCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  paymentsCmd
    .command("status")
    .description("Show payment connection, sync, and webhook status")
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (provider === "stripe") {
          const data = await getStripePaymentsStatus();

          if (json) {
            outputJson(data);
          } else if (data.connections.length === 0) {
            console.log("No Stripe payment environments found.");
          } else {
            outputTable(
              [
                "Env",
                "Status",
                "Key",
                "Account",
                "Webhook",
                "Last Sync",
                "Synced At",
              ],
              data.connections.map((connection) => [
                connection.environment,
                connection.status,
                connection.maskedKey ?? "-",
                connection.accountId ?? "-",
                connection.webhookEndpointId ? "Configured" : "-",
                connection.lastSyncStatus ?? "-",
                formatDate(connection.lastSyncedAt),
              ]),
            );
          }
        } else {
          const data = await getRazorpayPaymentsStatus();

          if (json) {
            outputJson(data);
          } else if (data.razorpayConnections.length === 0) {
            console.log("No Razorpay payment environments found.");
          } else {
            outputTable(
              [
                "Env",
                "Status",
                "Key",
                "Account",
                "Merchant",
                "Webhook",
                "Last Sync",
                "Synced At",
              ],
              data.razorpayConnections.map((connection) => [
                connection.environment,
                connection.status,
                connection.maskedKey ?? "-",
                connection.accountId ?? "-",
                connection.merchantName ?? "-",
                connection.webhookEndpointUrl ? "Manual" : "-",
                connection.lastSyncStatus ?? "-",
                formatDate(connection.lastSyncedAt),
              ]),
            );
          }
        }

        await trackPaymentUsage("status", true, { provider });
      } catch (err) {
        await trackPaymentUsage("status", false, { provider }, err);
        handleError(err, json);
      }
    });
}
