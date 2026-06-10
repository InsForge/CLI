import type { Command } from "commander";
import {
  createRazorpayItem,
  listRazorpayCatalog,
  updateRazorpayItem,
} from "../../lib/api/payments.js";
import { requireAuth } from "../../lib/credentials.js";
import { CLIError, getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputSuccess, outputTable } from "../../lib/output.js";
import type {
  CreateRazorpayItemBody,
  ListRazorpayCatalogResponse,
  UpdateRazorpayItemBody,
} from "@insforge/shared-schemas";
import {
  formatAmount,
  formatDate,
  nullableString,
  parseBooleanOption,
  parseEnvironment,
  parseIntegerOption,
  parseRequiredIntegerOption,
  trackPaymentUsage,
} from "./utils.js";

type RazorpayItem = ListRazorpayCatalogResponse["items"][number];

function outputItemsTable(items: RazorpayItem[]): void {
  if (items.length === 0) {
    console.log("No Razorpay items found.");
    return;
  }

  outputTable(
    ["Env", "Item ID", "Name", "Amount", "Active", "Type", "Synced At"],
    items.map((item) => [
      item.environment,
      item.itemId,
      item.name,
      formatAmount(item.amount, item.currency),
      item.active ? "Yes" : "No",
      item.type ?? "-",
      formatDate(item.syncedAt),
    ]),
  );
}

export function registerPaymentsItemsCommand(paymentsCmd: Command): void {
  const itemsCmd = paymentsCmd
    .command("items")
    .description("Manage Razorpay items");

  itemsCmd
    .command("list")
    .description("List mirrored Razorpay items")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth(apiUrl);

        const data = await listRazorpayCatalog(environment);

        if (json) {
          outputJson({ items: data.items });
        } else {
          outputItemsTable(data.items);
        }

        await trackPaymentUsage("items.list", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "items.list",
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

  itemsCmd
    .command("create")
    .description("Create a Razorpay item")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .requiredOption("--name <name>", "Item name")
    .requiredOption("--amount <amount>", "Amount in the smallest currency unit")
    .requiredOption(
      "--currency <currency>",
      "Three-letter currency code, e.g. inr",
    )
    .option("--description <description>", 'Item description, or "null"')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth(apiUrl);

        const request: CreateRazorpayItemBody = {
          name: opts.name,
          amount: parseRequiredIntegerOption(opts.amount, "--amount", {
            min: 0,
          }),
          currency: opts.currency,
        };
        const description = nullableString(opts.description);
        if (description !== undefined) request.description = description;

        const data = await createRazorpayItem(environment, request);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Razorpay item created: ${data.item.itemId}`);
        }

        await trackPaymentUsage("items.create", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "items.create",
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

  itemsCmd
    .command("update <itemId>")
    .description("Update a Razorpay item")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .option("--name <name>", "Item name")
    .option("--description <description>", 'Item description, or "null"')
    .option("--amount <amount>", "Amount in the smallest currency unit")
    .option("--currency <currency>", "Three-letter currency code")
    .option("--active <bool>", "Set active status (true/false)")
    .action(async (itemId: string, opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth(apiUrl);

        const request: UpdateRazorpayItemBody = {};
        const description = nullableString(opts.description);
        const amount = parseIntegerOption(opts.amount, "--amount", { min: 0 });
        const active = parseBooleanOption(opts.active, "--active");
        if (opts.name !== undefined) request.name = opts.name;
        if (description !== undefined) request.description = description;
        if (amount !== undefined) request.amount = amount;
        if (opts.currency !== undefined) request.currency = opts.currency;
        if (active !== undefined) request.active = active;

        if (Object.keys(request).length === 0) {
          throw new CLIError(
            "Provide at least one option to update (--name, --description, --amount, --currency, --active).",
          );
        }

        const data = await updateRazorpayItem(environment, itemId, request);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Razorpay item updated: ${data.item.itemId}`);
        }

        await trackPaymentUsage("items.update", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "items.update",
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
