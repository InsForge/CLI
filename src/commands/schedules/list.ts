import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

export function registerSchedulesListCommand(schedulesCmd: Command): void {
  schedulesCmd
    .command('list')
    .description('List all schedules')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch('/api/schedules');
        const data = await res.json();
        const schedules: Record<string, unknown>[] = Array.isArray(data) ? data : ((data as Record<string, unknown>).schedules as Record<string, unknown>[]) ?? [];

        if (json) {
          outputJson(schedules);
        } else {
          if (!schedules.length) {
            console.log('No schedules found.');
            return;
          }
          outputTable(
            ['ID', 'Name', 'Cron', 'URL', 'Method', 'Active', 'Next Run'],
            schedules.map((s) => [
              String(s.id ?? '-'),
              String(s.name ?? '-'),
              String(s.cronSchedule ?? '-'),
              String(s.functionUrl ?? '-'),
              String(s.httpMethod ?? '-'),
              s.isActive === false ? 'No' : 'Yes',
              s.nextRun ? new Date(String(s.nextRun)).toLocaleString() : '-',
            ]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
