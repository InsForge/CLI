import type { Command } from 'commander';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { shutdownAnalytics, trackVerifyFinding } from '../../lib/analytics.js';
import { classifyTruth, isReadOnlyQuery } from '../../lib/verify-probe.js';
import { runRawSql } from '../../lib/api/oss.js';

export function registerVerifyTruthCommand(verify: Command): void {
  verify
    .command('truth')
    .description('Backend-truth cross-check — compare a DB read to what the UI claimed (experimental)')
    .requiredOption('--query <sql>', 'a read proving what the UI showed; compares the first column of the first row')
    .option('--expect <value>', 'the value the UI displayed (compared as a scalar)')
    .option('--expect-count <n>', 'expect this many rows instead of a scalar value')
    .option('--table <name>', 'table name, for the finding label')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const config = getProjectConfig();
        if (!config) throw new CLIError('No linked project found — run `insforge link` first.');
        if (!isReadOnlyQuery(opts.query)) {
          throw new CLIError(
            'verify truth runs a single read-only query — it must start with SELECT or WITH and not chain statements.',
          );
        }
        if (opts.expect !== undefined && opts.expectCount !== undefined) {
          throw new CLIError('Provide either --expect <value> or --expect-count <n>, not both.');
        }

        const { rows } = await runRawSql(opts.query);

        let result: { type: 'false_pass' | 'none'; evidence: Record<string, unknown> };
        if (opts.expectCount !== undefined) {
          result = classifyTruth(rows.length, String(opts.expectCount));
        } else if (opts.expect !== undefined) {
          const first = rows[0];
          const dbValue =
            first && typeof first === 'object' ? Object.values(first as Record<string, unknown>)[0] : first;
          result = classifyTruth(dbValue, String(opts.expect));
        } else {
          throw new CLIError('Provide --expect <value> (scalar) or --expect-count <n> (row count).');
        }

        const finding = { type: result.type, table: opts.table as string | undefined, evidence: result.evidence };
        trackVerifyFinding(finding, config);
        await shutdownAnalytics(); // flush the PostHog event before exit

        if (json) {
          outputJson({ passed: result.type === 'none', finding });
        } else if (result.type === 'false_pass') {
          outputInfo(
            `❌ false_pass${opts.table ? ` on ${opts.table}` : ''}: UI claimed ${JSON.stringify(result.evidence.ui_claimed)} but DB has ${JSON.stringify(result.evidence.db_actual)}.`,
          );
        } else {
          outputInfo(`✅ backend truth matches: ${JSON.stringify(result.evidence.db_actual)}.`);
        }
        process.exitCode = result.type === 'none' ? 0 : 1;
      } catch (e) {
        handleError(e, json);
      }
    });
}
