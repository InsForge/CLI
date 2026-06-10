import type { Command } from "commander";
import {
  listRazorpaySubscriptions,
  listStripeSubscriptions,
} from "../../lib/api/payments.js";
import type { PaymentProvider } from "@insforge/shared-schemas";
import { requireAuth } from "../../lib/credentials.js";
import { getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputTable } from "../../lib/output.js";
import {
  formatDate,
  parseEnvironment,
  parseIntegerOption,
  trackPaymentUsage,
} from "./utils.js";

function formatSubject(
  subjectType: string | null | undefined,
  subjectId: string | null | undefined,
): string {
  return subjectType && subjectId ? `${subjectType}:${subjectId}` : "-";
}

export function registerPaymentsSubscriptionsCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  paymentsCmd
    .command("subscriptions")
    .description("List mirrored payment provider subscriptions")
    .requiredOption(
      "--environment <environment>",
      "Payment environment: test or live",
    )
    .option("--subject-type <type>", "Filter by app billing subject type")
    .option(
      "--subject-id <id>",
      "Filter by app billing subject id, not provider id",
    )
    .option("--limit <limit>", "Maximum rows to return (1-100)", "50")
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        const limit =
          parseIntegerOption(opts.limit, "--limit", { min: 1, max: 100 }) ?? 50;
        const request = {
          limit,
          ...(opts.subjectType !== undefined
            ? { subjectType: opts.subjectType }
            : {}),
          ...(opts.subjectId !== undefined
            ? { subjectId: opts.subjectId }
            : {}),
        };
        await requireAuth(apiUrl);

        if (provider === "stripe") {
          const data = await listStripeSubscriptions(environment, request);

          if (json) {
            outputJson(data);
          } else if (data.subscriptions.length === 0) {
            console.log("No Stripe subscriptions found.");
          } else {
            outputTable(
              [
                "Subscription ID",
                "Customer",
                "Subject",
                "Status",
                "Items",
                "Period End",
              ],
              data.subscriptions.map((subscription) => [
                subscription.subscriptionId,
                subscription.customerId ?? "-",
                formatSubject(subscription.subjectType, subscription.subjectId),
                subscription.status,
                String(subscription.items?.length ?? 0),
                formatDate(subscription.currentPeriodEnd),
              ]),
            );
          }
        } else {
          const data = await listRazorpaySubscriptions(environment, request);

          if (json) {
            outputJson(data);
          } else if (data.subscriptions.length === 0) {
            console.log("No Razorpay subscriptions found.");
          } else {
            outputTable(
              [
                "Subscription ID",
                "Plan ID",
                "Customer",
                "Subject",
                "Status",
                "Paid",
                "Remaining",
                "Current End",
              ],
              data.subscriptions.map((subscription) => [
                subscription.subscriptionId,
                subscription.planId,
                subscription.customerId ?? "-",
                formatSubject(subscription.subjectType, subscription.subjectId),
                subscription.status,
                String(subscription.paidCount ?? "-"),
                String(subscription.remainingCount ?? "-"),
                formatDate(subscription.currentEnd),
              ]),
            );
          }
        }

        await trackPaymentUsage("subscriptions", true, {
          provider,
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "subscriptions",
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
