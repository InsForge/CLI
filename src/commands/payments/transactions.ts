import type { Command } from "commander";
import { listPaymentTransactions } from "../../lib/api/payments.js";
import type { PaymentProvider } from "@insforge/shared-schemas";
import { requireAuth } from "../../lib/credentials.js";
import { getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputTable } from "../../lib/output.js";
import {
  formatAmount,
  formatDate,
  parseEnvironment,
  parseIntegerOption,
  trackPaymentUsage,
} from "./utils.js";

export function registerPaymentsTransactionsCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  paymentsCmd
    .command("transactions")
    .description("List mirrored payment transactions")
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
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        const limit =
          parseIntegerOption(opts.limit, "--limit", { min: 1, max: 100 }) ?? 50;
        await requireAuth();

        const data = await listPaymentTransactions(provider, environment, {
          limit,
          ...(opts.subjectType !== undefined
            ? { subjectType: opts.subjectType }
            : {}),
          ...(opts.subjectId !== undefined
            ? { subjectId: opts.subjectId }
            : {}),
        });

        if (json) {
          outputJson(data);
        } else if (data.transactions.length === 0) {
          console.log(`No ${provider} transactions found.`);
        } else {
          outputTable(
            [
              "Type",
              "Status",
              "Subject",
              "Amount",
              "Refunded",
              "Customer",
              "Provider Object",
              "When",
            ],
            data.transactions.map((entry) => [
              entry.type,
              entry.status,
              entry.subjectType && entry.subjectId
                ? `${entry.subjectType}:${entry.subjectId}`
                : "-",
              formatAmount(entry.amount, entry.currency),
              formatAmount(entry.amountRefunded, entry.currency),
              entry.providerCustomerId ?? entry.customerEmailSnapshot ?? "-",
              entry.providerReferenceType && entry.providerReferenceId
                ? `${entry.providerReferenceType}:${entry.providerReferenceId}`
                : (entry.providerReferenceId ?? "-"),
              formatDate(
                entry.paidAt ??
                  entry.failedAt ??
                  entry.refundedAt ??
                  entry.providerCreatedAt ??
                  entry.createdAt,
              ),
            ]),
          );
        }

        await trackPaymentUsage("transactions", true, {
          provider,
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "transactions",
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
