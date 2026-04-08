import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerComputeLogsCommand(computeCmd: Command): void {
  computeCmd
    .command('logs <id>')
    .description('Get compute service logs (machine events)')
    .option('--limit <n>', 'Max number of log entries', '50')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const limit = Number(opts.limit) || 50;
        const res = await ossFetch(
          `/api/compute/services/${encodeURIComponent(id)}/logs?limit=${limit}`,
        );
        const logs = await res.json() as { timestamp: number; message: string }[];

        if (json) {
          outputJson(logs);
        } else {
          if (!Array.isArray(logs) || logs.length === 0) {
            console.log('No logs found.');
            return;
          }
          for (const entry of logs) {
            const ts = new Date(entry.timestamp).toISOString();
            console.log(`${ts}  ${entry.message}`);
          }
        }
        await reportCliUsage('cli.compute.logs', true);
      } catch (err) {
        await reportCliUsage('cli.compute.logs', false);
        handleError(err, json);
      }
    });
}
