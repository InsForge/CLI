import type { Command } from 'commander';
import { listOrganizations } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerOrgsCommands(orgsCmd: Command): void {
  orgsCmd
    .command('list')
    .description('List all organizations')
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgs = await listOrganizations(apiUrl);

        await trackCommandUsage('orgs', 'list', true, { result_count: orgs.length });

        if (json) {
          outputJson(orgs);
        } else {
          if (!orgs.length) {
            console.log('No organizations found.');
            return;
          }
          outputTable(
            ['ID', 'Name', 'Type'],
            orgs.map((o) => [
              o.id,
              o.name,
              o.type ?? '-',
            ]),
          );
        }
      } catch (err) {
        await trackCommandUsage('orgs', 'list', false, {}, err);
        handleError(err, json);
      }
    });
}
