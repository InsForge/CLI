import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import type { DeleteSecretResponse } from '../../types.js';

export function registerSecretsDeleteCommand(secretsCmd: Command): void {
  secretsCmd
    .command('delete <key>')
    .description('Delete a secret')
    .action(async (key: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!yes && !json) {
          const confirm = await clack.confirm({
            message: `Delete secret "${key}"? This cannot be undone.`,
          });
          if (!confirm || clack.isCancel(confirm)) {
            process.exit(0);
          }
        }

        const res = await ossFetch(`/api/secrets/${encodeURIComponent(key)}`, {
          method: 'DELETE',
        });
        const data = await res.json() as DeleteSecretResponse;

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message ?? `Secret ${key} deleted.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
