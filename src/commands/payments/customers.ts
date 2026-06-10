import type { Command } from "commander";
import { listPaymentCustomers } from "../../lib/api/payments.js";
import type {
  ListPaymentCustomersResponse,
  PaymentProvider,
} from "@insforge/shared-schemas";
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

type PaymentCustomer = ListPaymentCustomersResponse["customers"][number];

function formatPaymentMethod(customer: PaymentCustomer): string {
  if (customer.paymentMethodBrand && customer.paymentMethodLast4) {
    return `${customer.paymentMethodBrand} **** ${customer.paymentMethodLast4}`;
  }
  if (customer.paymentMethodBrand) {
    return customer.paymentMethodBrand;
  }
  if (customer.paymentMethodLast4) {
    return `**** ${customer.paymentMethodLast4}`;
  }
  return "-";
}

export function registerPaymentsCustomersCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  paymentsCmd
    .command("customers")
    .description("List mirrored payment provider customers")
    .requiredOption(
      "--environment <environment>",
      "Payment environment: test or live",
    )
    .option("--limit <limit>", "Maximum rows to return (1-100)", "50")
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        const limit =
          parseIntegerOption(opts.limit, "--limit", { min: 1, max: 100 }) ?? 50;
        await requireAuth(apiUrl);

        const data = await listPaymentCustomers(provider, environment, {
          limit,
        });

        if (json) {
          outputJson(data);
        } else if (data.customers.length === 0) {
          console.log(`No ${provider} customers found.`);
        } else {
          outputTable(
            [
              "Customer ID",
              "Email",
              "Name",
              "Payments",
              "Total Spend",
              "Last Payment",
              "Method",
              "Country",
            ],
            data.customers.map((customer) => [
              customer.providerCustomerId,
              customer.email ?? "-",
              customer.name ?? "-",
              String(customer.paymentsCount),
              formatAmount(customer.totalSpend, customer.totalSpendCurrency),
              formatDate(customer.lastPaymentAt),
              formatPaymentMethod(customer),
              customer.countryCode?.toUpperCase() ?? "-",
            ]),
          );
        }

        await trackPaymentUsage("customers", true, { provider, environment });
      } catch (err) {
        await trackPaymentUsage(
          "customers",
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
