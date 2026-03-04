import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import type { GetSecretValueResponse } from '../../types.js';

export function registerSecretsGetCommand(secretsCmd: Command): void {
  secretsCmd
    .command('get <key>')
    .description('Get the decrypted value of a secret')
    .action(async (key: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch(`/api/secrets/${encodeURIComponent(key)}`);
        const data = await res.json();
        const secret = data as GetSecretValueResponse;

        if (json) {
          outputJson(data);
        } else {
          console.log(`${secret.key} = ${secret.value}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
