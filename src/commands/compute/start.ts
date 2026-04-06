import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerComputeStartCommand(computeCmd: Command): void {
  computeCmd
    .command('start <id>')
    .description('Start a stopped compute service')
    .action(async (id: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch(`/api/compute/services/${encodeURIComponent(id)}/start`, {
          method: 'POST',
        });
        const service = await res.json() as Record<string, unknown>;

        if (json) {
          outputJson(service);
        } else {
          outputSuccess(`Service "${service.name}" started [${service.status}]`);
          if (service.endpointUrl) {
            console.log(`  Endpoint: ${service.endpointUrl}`);
          }
        }
        await reportCliUsage('cli.compute.start', true);
      } catch (err) {
        await reportCliUsage('cli.compute.start', false);
        handleError(err, json);
      }
    });
}
