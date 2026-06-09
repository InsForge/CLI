import type { Command } from "commander";
import { registerPaymentsCatalogCommand } from "./catalog.js";
import { registerPaymentsConfigCommand } from "./config.js";
import { registerPaymentsCustomersCommand } from "./customers.js";
import { registerPaymentsItemsCommand } from "./items.js";
import { registerPaymentsPlansCommand } from "./plans.js";
import { registerPaymentsPricesCommand } from "./prices.js";
import { registerPaymentsProductsCommand } from "./products.js";
import { registerPaymentsStatusCommand } from "./status.js";
import { registerPaymentsSubscriptionsCommand } from "./subscriptions.js";
import { registerPaymentsSyncCommand } from "./sync.js";
import { registerPaymentsTransactionsCommand } from "./transactions.js";
import { registerPaymentsWebhooksCommand } from "./webhooks.js";

export function registerPaymentsCommands(paymentsCmd: Command): void {
  paymentsCmd.description("Manage payments");

  const stripeCmd = paymentsCmd
    .command("stripe")
    .description("Manage Stripe payments");
  registerPaymentsStatusCommand(stripeCmd, "stripe");
  registerPaymentsConfigCommand(stripeCmd, "stripe");
  registerPaymentsSyncCommand(stripeCmd, "stripe");
  registerPaymentsWebhooksCommand(stripeCmd);
  registerPaymentsCatalogCommand(stripeCmd, "stripe");
  registerPaymentsCustomersCommand(stripeCmd, "stripe");
  registerPaymentsProductsCommand(stripeCmd);
  registerPaymentsPricesCommand(stripeCmd);
  registerPaymentsSubscriptionsCommand(stripeCmd, "stripe");
  registerPaymentsTransactionsCommand(stripeCmd, "stripe");

  const razorpayCmd = paymentsCmd
    .command("razorpay")
    .description("Manage Razorpay payments");
  registerPaymentsStatusCommand(razorpayCmd, "razorpay");
  registerPaymentsConfigCommand(razorpayCmd, "razorpay");
  registerPaymentsSyncCommand(razorpayCmd, "razorpay");
  registerPaymentsCatalogCommand(razorpayCmd, "razorpay");
  registerPaymentsCustomersCommand(razorpayCmd, "razorpay");
  registerPaymentsItemsCommand(razorpayCmd);
  registerPaymentsPlansCommand(razorpayCmd);
  registerPaymentsSubscriptionsCommand(razorpayCmd, "razorpay");
  registerPaymentsTransactionsCommand(razorpayCmd, "razorpay");
}
