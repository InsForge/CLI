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
import { handleError, getRootOpts } from '../../lib/errors.js';
import { resolveOrgId } from '../../lib/resolve-org.js';
import { outputJson, outputTable, outputInfo } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

// Shown in help only. Not used to validate — the backend owns the plan enum,
// so a hard-coded allowlist here could reject a newly added plan.
const BILLING_PLANS = ['free', 'starter', 'pro', 'team', 'enterprise'];

/** Render a backend date-only string (YYYY-MM-DD) without UTC→local day shift. */
function formatCalendarDate(d: string): string {
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString();
}

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

        await trackCommandUsage('billing', 'status', true);

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
        await trackCommandUsage('billing', 'status', false, {}, err);
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

        await trackCommandUsage('billing', 'credits', true);

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
        await trackCommandUsage('billing', 'credits', false, {}, err);
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

        await trackCommandUsage('billing', 'history', true, { result_count: payments.length });

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
        await trackCommandUsage('billing', 'history', false, {}, err);
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

        await trackCommandUsage('billing', 'cycles', true);

        if (json) {
          outputJson(cycles);
        } else {
          const rows = [['current', `${formatCalendarDate(cycles.current.start_date)} → ${formatCalendarDate(cycles.current.end_date)}`]];
          if (cycles.previous) {
            rows.push(['previous', `${formatCalendarDate(cycles.previous.start_date)} → ${formatCalendarDate(cycles.previous.end_date)}`]);
          }
          outputTable(['Cycle', 'Window'], rows);
        }
      } catch (err) {
        await trackCommandUsage('billing', 'cycles', false, {}, err);
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
        // Plan is validated server-side against the canonical billing enum.
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const session = await createCheckoutSession(orgId, plan, apiUrl);

        await trackCommandUsage('billing', 'upgrade', true);

        if (json) {
          outputJson(session);
        } else {
          outputInfo(`Complete the upgrade to "${plan}" in your browser:`);
          outputInfo(session.checkoutUrl);
          await open(session.checkoutUrl).catch(() => { /* headless: URL already printed */ });
        }
      } catch (err) {
        await trackCommandUsage('billing', 'upgrade', false, {}, err);
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

        await trackCommandUsage('billing', 'manage', true);

        if (json) {
          outputJson(session);
        } else {
          outputInfo('Manage billing in your browser:');
          outputInfo(session.portalUrl);
          await open(session.portalUrl).catch(() => { /* headless: URL already printed */ });
        }
      } catch (err) {
        await trackCommandUsage('billing', 'manage', false, {}, err);
        handleError(err, json);
      }
    });
}
