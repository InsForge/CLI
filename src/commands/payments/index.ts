import type { Command } from 'commander';
import { registerPaymentsCatalogCommand } from './catalog.js';
import { registerPaymentsConfigCommand } from './config.js';
import { registerPaymentsHistoryCommand } from './history.js';
import { registerPaymentsPricesCommand } from './prices.js';
import { registerPaymentsProductsCommand } from './products.js';
import { registerPaymentsStatusCommand } from './status.js';
import { registerPaymentsSubscriptionsCommand } from './subscriptions.js';
import { registerPaymentsSyncCommand } from './sync.js';
import { registerPaymentsWebhooksCommand } from './webhooks.js';

export function registerPaymentsCommands(paymentsCmd: Command): void {
  paymentsCmd.description('Manage Stripe payments');

  registerPaymentsStatusCommand(paymentsCmd);
  registerPaymentsConfigCommand(paymentsCmd);
  registerPaymentsSyncCommand(paymentsCmd);
  registerPaymentsWebhooksCommand(paymentsCmd);
  registerPaymentsCatalogCommand(paymentsCmd);
  registerPaymentsProductsCommand(paymentsCmd);
  registerPaymentsPricesCommand(paymentsCmd);
  registerPaymentsSubscriptionsCommand(paymentsCmd);
  registerPaymentsHistoryCommand(paymentsCmd);
}
