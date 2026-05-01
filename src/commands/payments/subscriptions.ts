import type { Command } from 'commander';
import { listSubscriptions } from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import {
  formatDate,
  parseEnvironment,
  parseIntegerOption,
  trackPaymentUsage,
} from './utils.js';

export function registerPaymentsSubscriptionsCommand(paymentsCmd: Command): void {
  paymentsCmd
    .command('subscriptions')
    .description('List mirrored Stripe subscriptions')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .option('--subject-type <type>', 'Filter by billing subject type')
    .option('--subject-id <id>', 'Filter by billing subject id')
    .option('--limit <limit>', 'Maximum rows to return (1-100)', '50')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        const limit = parseIntegerOption(opts.limit, '--limit', { min: 1, max: 100 }) ?? 50;
        await requireAuth();

        const data = await listSubscriptions({
          environment,
          limit,
          ...(opts.subjectType !== undefined ? { subjectType: opts.subjectType } : {}),
          ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        });

        if (json) {
          outputJson(data);
        } else if (data.subscriptions.length === 0) {
          console.log('No Stripe subscriptions found.');
        } else {
          outputTable(
            ['Subscription ID', 'Customer', 'Subject', 'Status', 'Items', 'Period End'],
            data.subscriptions.map((subscription) => [
              subscription.stripeSubscriptionId,
              subscription.stripeCustomerId,
              subscription.subjectType && subscription.subjectId
                ? `${subscription.subjectType}:${subscription.subjectId}`
                : '-',
              subscription.status,
              String(subscription.items?.length ?? 0),
              formatDate(subscription.currentPeriodEnd),
            ]),
          );
        }

        await trackPaymentUsage('subscriptions', true, { environment });
      } catch (err) {
        await trackPaymentUsage('subscriptions', false, { environment: opts.environment });
        handleError(err, json);
      }
    });
}
