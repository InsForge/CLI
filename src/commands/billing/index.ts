import type { Command } from 'commander';
import open from 'open';
import {
  getSubscriptionStatus,
  getCredits,
  getPaymentHistory,
  getBillingCycles,
  createCheckoutSession,
  createPortalSession,
} from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { resolveOrgId } from '../../lib/resolve-org.js';
import { outputJson, outputTable, outputInfo } from '../../lib/output.js';

const BILLING_PLANS = ['free', 'starter', 'pro', 'team', 'enterprise'];

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

  billingCmd
    .command('history')
    .description('Show payment / invoice history')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const payments = await getPaymentHistory(orgId, apiUrl);

        if (json) {
          outputJson(payments);
        } else if (!payments.length) {
          outputInfo('No payments found.');
        } else {
          outputTable(
            ['Date', 'Amount', 'Currency', 'Status', 'Description'],
            payments.map((p) => [
              new Date(p.created_at).toLocaleDateString(),
              p.amount_display,
              (p.currency ?? '').toUpperCase(),
              p.status,
              p.description ?? '-',
            ]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  billingCmd
    .command('cycles')
    .description('Show the current and previous billing cycle windows')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const cycles = await getBillingCycles(orgId, apiUrl);

        if (json) {
          outputJson(cycles);
        } else {
          const fmt = (d: string): string => new Date(d).toLocaleDateString();
          const rows = [['current', `${fmt(cycles.current.start_date)} → ${fmt(cycles.current.end_date)}`]];
          if (cycles.previous) {
            rows.push(['previous', `${fmt(cycles.previous.start_date)} → ${fmt(cycles.previous.end_date)}`]);
          }
          outputTable(['Cycle', 'Window'], rows);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  billingCmd
    .command('upgrade <plan>')
    .description(`Start a checkout to change the plan (${BILLING_PLANS.join(' | ')})`)
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (plan: string, opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        if (!BILLING_PLANS.includes(plan)) {
          throw new CLIError(`Invalid plan "${plan}". Valid plans: ${BILLING_PLANS.join(', ')}.`);
        }
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const session = await createCheckoutSession(orgId, plan, apiUrl);

        if (json) {
          outputJson(session);
        } else {
          outputInfo(`Complete the upgrade to "${plan}" in your browser:`);
          outputInfo(session.checkoutUrl);
          await open(session.checkoutUrl).catch(() => { /* headless: URL already printed */ });
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  billingCmd
    .command('manage')
    .description('Open the Stripe customer portal (manage subscription / payment method)')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const session = await createPortalSession(orgId, apiUrl);

        if (json) {
          outputJson(session);
        } else {
          outputInfo('Manage billing in your browser:');
          outputInfo(session.portalUrl);
          await open(session.portalUrl).catch(() => { /* headless: URL already printed */ });
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
