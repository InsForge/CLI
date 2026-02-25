import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

export function registerSchedulesLogsCommand(schedulesCmd: Command): void {
  schedulesCmd
    .command('logs <id>')
    .description('Get execution logs for a schedule')
    .option('--limit <n>', 'Max logs to return (default: 50, max: 100)', '50')
    .option('--offset <n>', 'Pagination offset', '0')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const limit = parseInt(opts.limit, 10) || 50;
        const offset = parseInt(opts.offset, 10) || 0;

        const res = await ossFetch(`/api/schedules/${encodeURIComponent(id)}/logs?limit=${limit}&offset=${offset}`);
        const data = await res.json() as { logs: Record<string, unknown>[]; totalCount: number };
        const logs = data.logs ?? [];

        if (json) {
          outputJson(data);
        } else {
          if (!logs.length) {
            console.log('No execution logs found.');
            return;
          }
          outputTable(
            ['Executed At', 'Status', 'Success', 'Duration (ms)'],
            logs.map((l) => [
              l.executedAt ? new Date(String(l.executedAt)).toLocaleString() : '-',
              String(l.statusCode ?? '-'),
              l.success ? 'Yes' : 'No',
              String(l.durationMs ?? '-'),
            ]),
          );
          if (data.totalCount > offset + logs.length) {
            console.log(`\n  Showing ${offset + 1}-${offset + logs.length} of ${data.totalCount}. Use --offset to paginate.`);
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
