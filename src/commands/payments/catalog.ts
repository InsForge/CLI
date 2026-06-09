import type { Command } from "commander";
import {
  listRazorpayCatalog,
  listStripeCatalog,
} from "../../lib/api/payments.js";
import type { PaymentProvider } from "@insforge/shared-schemas";
import { requireAuth } from "../../lib/credentials.js";
import { getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputTable } from "../../lib/output.js";
import {
  formatAmount,
  formatRecurring,
  parseEnvironment,
  trackPaymentUsage,
} from "./utils.js";

export function registerPaymentsCatalogCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  paymentsCmd
    .command("catalog")
    .description("List mirrored provider catalog records for one environment")
    .requiredOption(
      "--environment <environment>",
      "Payment environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        if (provider === "stripe") {
          const data = await listStripeCatalog(environment);

          if (json) {
            outputJson(data);
          } else {
            if (data.products.length === 0 && data.prices.length === 0) {
              console.log("No Stripe catalog records found.");
              await trackPaymentUsage("catalog", true, {
                provider,
                environment,
              });
              return;
            }

            if (data.products.length > 0) {
              console.log("Products");
              outputTable(
                ["Env", "Product ID", "Name", "Active", "Default Price"],
                data.products.map((product) => [
                  product.environment,
                  product.productId,
                  product.name,
                  product.active ? "Yes" : "No",
                  product.defaultPriceId ?? "-",
                ]),
              );
            }

            if (data.prices.length > 0) {
              console.log("Prices");
              outputTable(
                [
                  "Env",
                  "Price ID",
                  "Product ID",
                  "Amount",
                  "Type",
                  "Active",
                  "Recurring",
                ],
                data.prices.map((price) => [
                  price.environment,
                  price.priceId,
                  price.productId ?? "-",
                  formatAmount(price.unitAmount, price.currency),
                  price.type,
                  price.active ? "Yes" : "No",
                  formatRecurring(
                    price.recurringInterval,
                    price.recurringIntervalCount,
                  ),
                ]),
              );
            }
          }
        } else {
          const data = await listRazorpayCatalog(environment);

          if (json) {
            outputJson(data);
          } else {
            if (data.items.length === 0 && data.plans.length === 0) {
              console.log("No Razorpay catalog records found.");
              await trackPaymentUsage("catalog", true, {
                provider,
                environment,
              });
              return;
            }

            if (data.items.length > 0) {
              console.log("Items");
              outputTable(
                ["Env", "Item ID", "Name", "Amount", "Active", "Type"],
                data.items.map((item) => [
                  item.environment,
                  item.itemId,
                  item.name,
                  formatAmount(item.amount, item.currency),
                  item.active ? "Yes" : "No",
                  item.type ?? "-",
                ]),
              );
            }

            if (data.plans.length > 0) {
              console.log("Plans");
              outputTable(
                [
                  "Env",
                  "Plan ID",
                  "Item ID",
                  "Amount",
                  "Period",
                  "Interval",
                  "Active",
                ],
                data.plans.map((plan) => [
                  plan.environment,
                  plan.planId,
                  plan.itemId,
                  formatAmount(plan.amount, plan.currency),
                  plan.period,
                  String(plan.interval),
                  plan.active ? "Yes" : "No",
                ]),
              );
            }
          }
        }

        await trackPaymentUsage("catalog", true, { provider, environment });
      } catch (err) {
        await trackPaymentUsage(
          "catalog",
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
