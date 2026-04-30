import type { Command } from 'commander';
import { listPaymentCatalog } from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { formatAmount, formatRecurring, parseEnvironment, trackPaymentUsage } from './utils.js';

export function registerPaymentsCatalogCommand(paymentsCmd: Command): void {
  paymentsCmd
    .command('catalog')
    .description('List mirrored Stripe products and prices')
    .option('--environment <environment>', 'Stripe environment: test or live')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = opts.environment ? parseEnvironment(opts.environment) : undefined;
        await requireAuth();

        const data = await listPaymentCatalog(environment);

        if (json) {
          outputJson(data);
        } else {
          if (data.products.length === 0 && data.prices.length === 0) {
            console.log('No Stripe catalog records found.');
            await trackPaymentUsage('catalog', true, { environment });
            return;
          }

          if (data.products.length > 0) {
            console.log('Products');
            outputTable(
              ['Env', 'Product ID', 'Name', 'Active', 'Default Price'],
              data.products.map((product) => [
                product.environment,
                product.stripeProductId,
                product.name,
                product.active ? 'Yes' : 'No',
                product.defaultPriceId ?? '-',
              ]),
            );
          }

          if (data.prices.length > 0) {
            console.log('Prices');
            outputTable(
              ['Env', 'Price ID', 'Product ID', 'Amount', 'Type', 'Active', 'Recurring'],
              data.prices.map((price) => [
                price.environment,
                price.stripePriceId,
                price.stripeProductId ?? '-',
                formatAmount(price.unitAmount, price.currency),
                price.type,
                price.active ? 'Yes' : 'No',
                formatRecurring(price.recurringInterval, price.recurringIntervalCount),
              ]),
            );
          }
        }

        await trackPaymentUsage('catalog', true, { environment });
      } catch (err) {
        await trackPaymentUsage('catalog', false, { environment: opts.environment });
        handleError(err, json);
      }
    });
}
