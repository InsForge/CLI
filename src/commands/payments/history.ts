import type { Command } from 'commander';
import { listPaymentHistory } from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import {
  formatAmount,
  formatDate,
  parseEnvironment,
  parseIntegerOption,
  trackPaymentUsage,
} from './utils.js';

export function registerPaymentsHistoryCommand(paymentsCmd: Command): void {
  paymentsCmd
    .command('history')
    .description('List mirrored Stripe payment history')
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

        const data = await listPaymentHistory({
          environment,
          limit,
          ...(opts.subjectType !== undefined ? { subjectType: opts.subjectType } : {}),
          ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        });

        if (json) {
          outputJson(data);
        } else if (data.paymentHistory.length === 0) {
          console.log('No Stripe payment history found.');
        } else {
          outputTable(
            ['Type', 'Status', 'Subject', 'Amount', 'Customer', 'Stripe Object', 'When'],
            data.paymentHistory.map((entry) => [
              entry.type,
              entry.status,
              entry.subjectType && entry.subjectId ? `${entry.subjectType}:${entry.subjectId}` : '-',
              formatAmount(entry.amount, entry.currency),
              entry.stripeCustomerId ?? '-',
              entry.stripeCheckoutSessionId
                ?? entry.stripeInvoiceId
                ?? entry.stripePaymentIntentId
                ?? entry.stripeRefundId
                ?? '-',
              formatDate(entry.paidAt ?? entry.failedAt ?? entry.refundedAt ?? entry.stripeCreatedAt),
            ]),
          );
        }

        await trackPaymentUsage('history', true, { environment });
      } catch (err) {
        await trackPaymentUsage('history', false, { environment: opts.environment });
        handleError(err, json);
      }
    });
}
