import type { Command } from 'commander';
import * as prompts from '../../lib/prompts.js';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import type { DeleteSecretResponse } from '../../types.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerSecretsDeleteCommand(secretsCmd: Command): void {
  secretsCmd
    .command('delete <key>')
    .description('Delete a secret')
    .action(async (key: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!yes && !json) {
          const confirm = await prompts.confirm({
            message: `Delete secret "${key}"? This cannot be undone.`,
          });
          if (prompts.isCancel(confirm) || !confirm) {
            process.exit(0);
          }
        }

        const res = await ossFetch(`/api/secrets/${encodeURIComponent(key)}`, {
          method: 'DELETE',
        });
        const data = await res.json() as DeleteSecretResponse;

        await trackCommandUsage('secrets', 'delete', true);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message ?? `Secret ${key} deleted.`);
        }
      } catch (err) {
        await trackCommandUsage('secrets', 'delete', false, {}, err);
        handleError(err, json);
      }
    });
}
