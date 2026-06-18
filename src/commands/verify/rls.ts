import type { Command } from 'commander';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { shutdownAnalytics, trackVerifyFinding } from '../../lib/analytics.js';
import { classifyRls, getAnonKey, login, rawsqlRows, recordsCount } from '../../lib/verify-probe.js';

export function registerVerifyRlsCommand(verify: Command): void {
  verify
    .command('rls')
    .description('Cross-user RLS isolation probe — checks B cannot read A, A can read own (experimental)')
    .requiredOption('--table <name>', 'user-scoped table to probe')
    .requiredOption('--owner <column>', 'owner column on the table (e.g. user_id)')
    .option('--user-a <email>', 'seeded user A email', 'verify-a@example.com')
    .option('--user-b <email>', 'seeded user B email', 'verify-b@example.com')
    .option('--password <pw>', 'seeded users password', 'Test1234!pass')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const config = getProjectConfig();
        if (!config) throw new CLIError('No linked project found — run `insforge link` first.');
        const baseUrl = config.oss_host;
        const adminKey = config.api_key;

        const aToken = await login(baseUrl, opts.userA, opts.password);
        const bToken = await login(baseUrl, opts.userB, opts.password);
        const anon = await getAnonKey(baseUrl, adminKey);
        if (!aToken || !bToken || !anon) {
          throw new CLIError(
            'Login or anon-key fetch returned empty — seed BOTH users first. An empty token turns every probe into an anonymous request that silently "passes" isolation.',
          );
        }

        const rows = await rawsqlRows(
          baseUrl,
          adminKey,
          `select id from auth.users where email='${String(opts.userA).replace(/'/g, "''")}'`,
        );
        const aId = (rows[0] as { id?: string })?.id;
        if (!aId) throw new CLIError(`Could not find user A (${opts.userA}) — seed it first.`);

        const filter = `${opts.owner}=eq.${aId}`;
        const bReadRowsOfA = await recordsCount(baseUrl, opts.table, filter, bToken, anon);
        const aReadOwnRows = await recordsCount(baseUrl, opts.table, filter, aToken, anon);
        const anonReadRows = await recordsCount(baseUrl, opts.table, undefined, undefined, anon);

        const { type, evidence } = classifyRls({ bReadRowsOfA, aReadOwnRows, anonReadRows });
        const finding = { type, table: opts.table as string, evidence };
        trackVerifyFinding(finding, config);
        await shutdownAnalytics(); // flush the PostHog event before exit

        if (json) {
          outputJson({ passed: type === 'none', finding });
        } else if (type === 'rls_leak') {
          outputInfo(`❌ rls_leak on ${opts.table}: B read ${bReadRowsOfA} of A's rows (anon read ${anonReadRows}).`);
        } else if (type === 'rls_overrestrict') {
          outputInfo(`❌ rls_overrestrict on ${opts.table}: A could not read its own rows (positive control empty).`);
        } else {
          outputInfo(`✅ isolation holds on ${opts.table}: B=0, anon=0, A=${aReadOwnRows}.`);
        }
        process.exitCode = type === 'none' ? 0 : 1;
      } catch (e) {
        handleError(e, json);
      }
    });
}
