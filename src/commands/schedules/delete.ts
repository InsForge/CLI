import type { Command } from 'commander';
import * as prompts from '../../lib/prompts.js';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';

export function registerSchedulesDeleteCommand(schedulesCmd: Command): void {
  schedulesCmd
    .command('delete <id>')
    .description('Delete a schedule')
    .action(async (id: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!yes && !json) {
          const confirm = await prompts.confirm({
            message: `Delete schedule "${id}"? This cannot be undone.`,
          });
          if (prompts.isCancel(confirm) || !confirm) {
            process.exit(0);
          }
        }

        const res = await ossFetch(`/api/schedules/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const data = await res.json() as { success: boolean; message: string };

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message ?? 'Schedule deleted.');
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
