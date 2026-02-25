import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';

export function registerSchedulesGetCommand(schedulesCmd: Command): void {
  schedulesCmd
    .command('get <id>')
    .description('Get schedule details')
    .action(async (id: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch(`/api/schedules/${encodeURIComponent(id)}`);
        const data = await res.json() as Record<string, unknown>;

        if (json) {
          outputJson(data);
        } else {
          console.log(`\n  Name:     ${data.name ?? '-'}`);
          console.log(`  ID:       ${data.id ?? '-'}`);
          console.log(`  Cron:     ${data.cronSchedule ?? '-'}`);
          console.log(`  URL:      ${data.functionUrl ?? '-'}`);
          console.log(`  Method:   ${data.httpMethod ?? '-'}`);
          console.log(`  Active:   ${data.isActive === false ? 'No' : 'Yes'}`);
          if (data.headers) console.log(`  Headers:  ${JSON.stringify(data.headers)}`);
          if (data.body) console.log(`  Body:     ${JSON.stringify(data.body)}`);
          console.log(`  Next Run: ${data.nextRun ? new Date(String(data.nextRun)).toLocaleString() : '-'}`);
          console.log(`  Created:  ${data.createdAt ? new Date(String(data.createdAt)).toLocaleString() : '-'}`);
          console.log('');
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
