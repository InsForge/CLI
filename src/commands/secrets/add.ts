import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import type { CreateSecretResponse } from '../../types.js';

export function registerSecretsAddCommand(secretsCmd: Command): void {
  secretsCmd
    .command('add <key> <value>')
    .description('Create a new secret')
    .option('--reserved', 'Mark secret as protected from deletion')
    .option('--expires <date>', 'Expiration date (ISO 8601 format)')
    .action(async (key: string, value: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body: Record<string, unknown> = { key, value };
        if (opts.reserved) body.isReserved = true;
        if (opts.expires) body.expiresAt = opts.expires;

        const res = await ossFetch('/api/secrets', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const data = await res.json() as CreateSecretResponse;

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message ?? `Secret ${key} created.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
