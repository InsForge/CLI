import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { ListSecretsResponse } from '../../types.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerSecretsListCommand(secretsCmd: Command): void {
  secretsCmd
    .command('list')
    .description('List secrets (metadata only, values are hidden)')
    .option('--all', 'Include inactive (deleted) secrets')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/secrets');
        const data = await res.json() as ListSecretsResponse;
        let secrets = data.secrets ?? [];

        if (!opts.all) {
          secrets = secrets.filter((s) => s.isActive !== false);
        }

        await trackCommandUsage('secrets', 'list', true, {
          result_count: secrets.length,
          all: !!opts.all,
        });

        if (json) {
          outputJson(opts.all ? data : { secrets });
        } else {
          if (!secrets.length) {
            console.log('No secrets found.');
            return;
          }
          const headers = opts.all
            ? ['Key', 'Active', 'Reserved', 'Expires', 'Updated']
            : ['Key', 'Reserved', 'Expires', 'Updated'];
          outputTable(
            headers,
            secrets.map((s) => {
              const row = [
                String(s.key ?? '-'),
                ...(opts.all ? [s.isActive ? 'Yes' : 'No'] : []),
                s.isReserved ? 'Yes' : 'No',
                s.expiresAt ? new Date(String(s.expiresAt)).toLocaleString() : '-',
                s.updatedAt ? new Date(String(s.updatedAt)).toLocaleString() : '-',
              ];
              return row;
            }),
          );
        }
        await reportCliUsage('cli.secrets.list', true);
      } catch (err) {
        await reportCliUsage('cli.secrets.list', false);
        await trackCommandUsage('secrets', 'list', false, {}, err);
        handleError(err, json);
      }
    });
}
