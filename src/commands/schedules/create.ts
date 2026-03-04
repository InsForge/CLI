import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import type { CreateScheduleResponse } from '../../types.js';

export function registerSchedulesCreateCommand(schedulesCmd: Command): void {
  schedulesCmd
    .command('create')
    .description('Create a new schedule')
    .requiredOption('--name <name>', 'Schedule name')
    .requiredOption('--cron <expression>', 'Cron expression (5-field format)')
    .requiredOption('--url <url>', 'URL to invoke')
    .requiredOption('--method <method>', 'HTTP method (GET, POST, PUT, PATCH, DELETE)')
    .option('--headers <json>', 'HTTP headers as JSON')
    .option('--body <json>', 'Request body as JSON')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body: Record<string, unknown> = {
          name: opts.name,
          cronSchedule: opts.cron,
          functionUrl: opts.url,
          httpMethod: opts.method.toUpperCase(),
        };

        if (opts.headers) {
          try {
            body.headers = JSON.parse(opts.headers);
          } catch {
            throw new CLIError('Invalid JSON for --headers');
          }
        }
        if (opts.body) {
          try {
            body.body = JSON.parse(opts.body);
          } catch {
            throw new CLIError('Invalid JSON for --body');
          }
        }

        const res = await ossFetch('/api/schedules', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const data = await res.json() as CreateScheduleResponse;

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Schedule "${opts.name}" created (ID: ${data.id ?? 'unknown'}).`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
