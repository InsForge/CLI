import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';

export function registerSchedulesUpdateCommand(schedulesCmd: Command): void {
  schedulesCmd
    .command('update <id>')
    .description('Update a schedule')
    .option('--name <name>', 'New schedule name')
    .option('--cron <expression>', 'New cron expression')
    .option('--url <url>', 'New URL to invoke')
    .option('--method <method>', 'New HTTP method')
    .option('--headers <json>', 'New HTTP headers as JSON')
    .option('--body <json>', 'New request body as JSON')
    .option('--active <bool>', 'Enable/disable schedule (true/false)')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const body: Record<string, unknown> = {};
        if (opts.name !== undefined) body.name = opts.name;
        if (opts.cron !== undefined) body.cronSchedule = opts.cron;
        if (opts.url !== undefined) body.functionUrl = opts.url;
        if (opts.method !== undefined) body.httpMethod = opts.method.toUpperCase();
        if (opts.active !== undefined) body.isActive = opts.active === 'true';

        if (opts.headers !== undefined) {
          try {
            body.headers = JSON.parse(opts.headers);
          } catch {
            throw new CLIError('Invalid JSON for --headers');
          }
        }
        if (opts.body !== undefined) {
          try {
            body.body = JSON.parse(opts.body);
          } catch {
            throw new CLIError('Invalid JSON for --body');
          }
        }

        if (Object.keys(body).length === 0) {
          throw new CLIError('Provide at least one option to update (--name, --cron, --url, --method, --headers, --body, --active).');
        }

        const res = await ossFetch(`/api/schedules/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        const data = await res.json() as { success: boolean; message: string };

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message ?? 'Schedule updated.');
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
