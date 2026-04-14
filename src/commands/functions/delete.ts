import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as prompts from '../../lib/prompts.js';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import type { FunctionResponse } from '../../types.js';

export function registerFunctionsDeleteCommand(functionsCmd: Command): void {
  functionsCmd
    .command('delete <slug>')
    .description('Delete an edge function')
    .action(async (slug: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!yes && !json) {
          const confirmed = await prompts.confirm({
            message: `Delete function "${slug}"? This cannot be undone.`,
          });
          if (prompts.isCancel(confirmed) || !confirmed) {
            clack.log.info('Cancelled.');
            return;
          }
        }

        const res = await ossFetch(`/api/functions/${encodeURIComponent(slug)}`, {
          method: 'DELETE',
        });
        const result = await res.json() as FunctionResponse;

        if (json) {
          outputJson(result);
        } else {
          if (result.success) {
            outputSuccess(`Function "${slug}" deleted successfully.`);
          } else {
            outputSuccess(`Failed to delete function "${slug}".`);
          }
        }
        await reportCliUsage('cli.functions.delete', true);
      } catch (err) {
        await reportCliUsage('cli.functions.delete', false);
        handleError(err, json);
      }
    });
}
