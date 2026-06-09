import type { Command } from "commander";
import {
  createRazorpayPlan,
  listRazorpayCatalog,
} from "../../lib/api/payments.js";
import { requireAuth } from "../../lib/credentials.js";
import { CLIError, getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputSuccess, outputTable } from "../../lib/output.js";
import type {
  CreateRazorpayPlanBody,
  ListRazorpayCatalogResponse,
} from "@insforge/shared-schemas";
import {
  formatAmount,
  formatDate,
  parseEnvironment,
  parseIntegerOption,
  parseMetadataOption,
  parseRazorpayPlanPeriod,
  trackPaymentUsage,
} from "./utils.js";

type RazorpayPlan = ListRazorpayCatalogResponse["plans"][number];

function nullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === "null" ? null : value;
}

function outputPlansTable(plans: RazorpayPlan[]): void {
  if (plans.length === 0) {
    console.log("No Razorpay plans found.");
    return;
  }

  outputTable(
    [
      "Env",
      "Plan ID",
      "Item ID",
      "Amount",
      "Period",
      "Interval",
      "Active",
      "Synced At",
    ],
    plans.map((plan) => [
      plan.environment,
      plan.planId,
      plan.itemId,
      formatAmount(plan.amount, plan.currency),
      plan.period,
      String(plan.interval),
      plan.active ? "Yes" : "No",
      formatDate(plan.syncedAt),
    ]),
  );
}

export function registerPaymentsPlansCommand(paymentsCmd: Command): void {
  const plansCmd = paymentsCmd
    .command("plans")
    .description("Manage Razorpay plans");

  plansCmd
    .command("list")
    .description("List mirrored Razorpay plans")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const data = await listRazorpayCatalog(environment);

        if (json) {
          outputJson({ plans: data.plans });
        } else {
          outputPlansTable(data.plans);
        }

        await trackPaymentUsage("plans.list", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "plans.list",
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

  plansCmd
    .command("create")
    .description("Create a Razorpay subscription plan")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .requiredOption(
      "--period <period>",
      "Plan period: daily, weekly, monthly, or yearly",
    )
    .requiredOption("--interval <count>", "Billing interval count")
    .requiredOption("--item-name <name>", "Plan item name")
    .requiredOption(
      "--item-amount <amount>",
      "Plan item amount in the smallest currency unit",
    )
    .requiredOption(
      "--item-currency <currency>",
      "Three-letter currency code, e.g. inr",
    )
    .option(
      "--item-description <description>",
      'Plan item description, or "null"',
    )
    .option("--metadata <json>", "Metadata JSON object with string values")
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        const period = parseRazorpayPlanPeriod(opts.period);
        const interval = parseIntegerOption(opts.interval, "--interval", {
          min: 1,
        });
        const itemAmount = parseIntegerOption(
          opts.itemAmount,
          "--item-amount",
          { min: 0 },
        );
        if (!period || interval === undefined || itemAmount === undefined) {
          throw new CLIError(
            "Provide --period, --interval, and --item-amount.",
          );
        }
        await requireAuth();

        const request: CreateRazorpayPlanBody = {
          period,
          interval,
          item: {
            name: opts.itemName,
            amount: itemAmount,
            currency: opts.itemCurrency,
          },
        };
        const itemDescription = nullableString(opts.itemDescription);
        const metadata = parseMetadataOption(opts.metadata);
        if (itemDescription !== undefined) {
          request.item.description = itemDescription;
        }
        if (metadata !== undefined) request.metadata = metadata;

        const data = await createRazorpayPlan(environment, request);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Razorpay plan created: ${data.plan.planId}`);
        }

        await trackPaymentUsage("plans.create", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "plans.create",
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
