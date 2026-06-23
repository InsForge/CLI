import type { Command } from 'commander';
import { getSubscriptionStatus, getCredits } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { resolveOrgId } from '../../lib/resolve-org.js';
import { outputJson, outputTable, outputInfo } from '../../lib/output.js';

export function registerBillingCommands(billingCmd: Command): void {
  billingCmd
    .command('status')
    .description('Show the organization subscription / current plan')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const sub = await getSubscriptionStatus(orgId, apiUrl);

        if (json) {
          outputJson(sub);
        } else {
          outputTable(
            ['Field', 'Value'],
            [
              ['Plan', sub.plan],
              ['Status', sub.status],
              ['Current period end', sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleString() : '-'],
              ['Cancels at period end', sub.cancelAtPeriodEnd ? 'yes' : 'no'],
            ],
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  billingCmd
    .command('credits')
    .description('Show the organization credit balance')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const credits = await getCredits(orgId, apiUrl);

        if (json) {
          outputJson(credits);
        } else {
          outputInfo(`Credit balance: ${credits.creditBalanceFormatted}`);
          if (credits.transactions.length) {
            outputTable(
              ['Date', 'Amount', 'Description'],
              credits.transactions.map((t) => [
                new Date(t.created).toLocaleDateString(),
                `${(t.amountCents / 100).toFixed(2)}`,
                t.description,
              ]),
            );
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
