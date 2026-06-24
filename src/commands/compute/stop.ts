import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerComputeStopCommand(computeCmd: Command): void {
  computeCmd
    .command('stop <id>')
    .description('Stop a running compute service')
    .action(async (id: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch(`/api/compute/services/${encodeURIComponent(id)}/stop`, {
          method: 'POST',
        });
        const service = await res.json() as Record<string, unknown>;

        await trackCommandUsage('compute', 'stop', true);

        if (json) {
          outputJson(service);
        } else {
          outputSuccess(`Service "${service.name}" stopped.`);
        }
        await reportCliUsage('cli.compute.stop', true);
      } catch (err) {
        await reportCliUsage('cli.compute.stop', false);
        await trackCommandUsage('compute', 'stop', false, {}, err);
        handleError(err, json);
      }
    });
}
