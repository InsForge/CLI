import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import type { UpdateSecretResponse } from '../../types.js';

export function registerSecretsUpdateCommand(secretsCmd: Command): void {
  secretsCmd
    .command('update <key>')
    .description('Update an existing secret')
    .option('--value <value>', 'New secret value')
    .option('--active <bool>', 'Set active status (true/false)')
    .option('--reserved <bool>', 'Set reserved status (true/false)')
    .option('--expires <date>', 'Expiration date (ISO 8601, or "null" to remove)')
    .action(async (key: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body: Record<string, unknown> = {};
        if (opts.value !== undefined) body.value = opts.value;
        if (opts.active !== undefined) body.isActive = opts.active === 'true';
        if (opts.reserved !== undefined) body.isReserved = opts.reserved === 'true';
        if (opts.expires !== undefined) body.expiresAt = opts.expires === 'null' ? null : opts.expires;

        if (Object.keys(body).length === 0) {
          throw new CLIError('Provide at least one option to update (--value, --active, --reserved, --expires).');
        }

        const res = await ossFetch(`/api/secrets/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        const data = await res.json() as UpdateSecretResponse;

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message ?? `Secret ${key} updated.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
