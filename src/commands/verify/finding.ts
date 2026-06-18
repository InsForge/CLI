import type { Command } from 'commander';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { shutdownAnalytics, trackVerifyFinding } from '../../lib/analytics.js';
import { getProjectConfig } from '../../lib/config.js';

// Record a "loud" error the browser surfaced during the drive — a 4xx/5xx, a
// `column does not exist`, a console exception — that the agent saw via
// `browser_console_messages` / `browser_network_requests`. The rls/truth probes
// only cover the *silent* findings; this is how the loud ones reach PostHog too.
export function registerVerifyFindingCommand(verify: Command): void {
  verify
    .command('finding')
    .description('Record a loud error surfaced during the drive (4xx/5xx, column-not-found, console) as a finding (experimental)')
    .requiredOption('--kind <kind>', 'short error kind, e.g. pgrst_column_not_found, http_500, console_error')
    .option('--type <type>', 'finding type', 'error')
    .option('--status <n>', 'HTTP status, if any', (v) => parseInt(v, 10))
    .option('--endpoint <path>', 'the endpoint/URL that errored')
    .option('--message <text>', 'the error message the page showed')
    .option('--table <name>', 'related table, if known')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const config = getProjectConfig();
        if (!config) throw new CLIError('No linked project found — run `insforge link` first.');
        const finding = {
          type: opts.type as string,
          kind: opts.kind as string,
          status: Number.isNaN(opts.status) ? undefined : (opts.status as number | undefined),
          endpoint: opts.endpoint as string | undefined,
          message: opts.message as string | undefined,
          table: opts.table as string | undefined,
        };
        trackVerifyFinding(finding, config);
        await shutdownAnalytics(); // flush the PostHog event before exit

        if (json) {
          outputJson({ recorded: true, finding });
        } else {
          outputInfo(
            `📝 recorded ${finding.type} finding: ${finding.kind}${finding.status ? ` (${finding.status})` : ''}${finding.message ? ` — ${finding.message}` : ''}`,
          );
        }
      } catch (e) {
        handleError(e, json);
      }
    });
}
