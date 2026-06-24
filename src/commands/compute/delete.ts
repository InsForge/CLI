import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerComputeDeleteCommand(computeCmd: Command): void {
  computeCmd
    .command('delete <id>')
    .description('Delete a compute service and its Fly.io resources')
    .action(async (id: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch(`/api/compute/services/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const data = await res.json() as Record<string, unknown>;

        await trackCommandUsage('compute', 'delete', true);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess('Service deleted.');
        }
        await reportCliUsage('cli.compute.delete', true);
      } catch (err) {
        await reportCliUsage('cli.compute.delete', false);
        await trackCommandUsage('compute', 'delete', false, {}, err);
        handleError(err, json);
      }
    });
}
