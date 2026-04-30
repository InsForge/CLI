import type { Command } from 'commander';
import { getPaymentsStatus } from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { formatDate, trackPaymentUsage } from './utils.js';

export function registerPaymentsStatusCommand(paymentsCmd: Command): void {
  paymentsCmd
    .command('status')
    .description('Show Stripe payment connection, sync, and webhook status')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const data = await getPaymentsStatus();

        if (json) {
          outputJson(data);
        } else if (data.connections.length === 0) {
          console.log('No Stripe payment environments found.');
        } else {
          outputTable(
            ['Env', 'Status', 'Key', 'Account', 'Webhook', 'Last Sync', 'Synced At'],
            data.connections.map((connection) => [
              connection.environment,
              connection.status,
              connection.maskedKey ?? '-',
              connection.stripeAccountId ?? '-',
              connection.webhookEndpointId ? 'Configured' : '-',
              connection.lastSyncStatus ?? '-',
              formatDate(connection.lastSyncedAt),
            ]),
          );
        }

        await trackPaymentUsage('status', true);
      } catch (err) {
        await trackPaymentUsage('status', false);
        handleError(err, json);
      }
    });
}
