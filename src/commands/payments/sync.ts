import type { Command } from 'commander';
import { syncPayments } from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputTable } from '../../lib/output.js';
import { formatDate, parseEnvironmentOrAll, trackPaymentUsage } from './utils.js';

export function registerPaymentsSyncCommand(paymentsCmd: Command): void {
  paymentsCmd
    .command('sync')
    .description('Sync configured Stripe products, prices, and subscriptions')
    .option('--environment <environment>', 'Stripe environment: test, live, or all', 'all')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironmentOrAll(opts.environment);
        await requireAuth();

        const data = await syncPayments(environment);

        if (json) {
          outputJson(data);
        } else if (data.results.length === 0) {
          console.log('No configured Stripe environments to sync.');
        } else {
          outputTable(
            ['Env', 'Status', 'Products', 'Prices', 'Subscriptions', 'Unmapped', 'Synced At'],
            data.results.map((result) => [
              result.environment,
              result.connection.lastSyncStatus ?? result.connection.status,
              String(result.connection.lastSyncCounts.products ?? 0),
              String(result.connection.lastSyncCounts.prices ?? 0),
              String(result.subscriptions?.synced ?? 0),
              String(result.subscriptions?.unmapped ?? 0),
              formatDate(result.connection.lastSyncedAt),
            ]),
          );
          outputSuccess('Stripe payments synced.');
        }

        await trackPaymentUsage('sync', true, { environment });
      } catch (err) {
        await trackPaymentUsage('sync', false, { environment: opts.environment });
        handleError(err, json);
      }
    });
}
