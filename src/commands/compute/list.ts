import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerComputeListCommand(computeCmd: Command): void {
  computeCmd
    .command('list')
    .description('List all compute services')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/compute/services');
        const raw = await res.json();
        const services: Record<string, unknown>[] = Array.isArray(raw) ? raw : [];

        if (json) {
          outputJson(services);
        } else {
          if (services.length === 0) {
            console.log('No compute services found.');
            return;
          }
          outputTable(
            ['Name', 'Status', 'Image', 'CPU', 'Memory', 'Endpoint'],
            services.map((s) => [
              String(s.name ?? '-'),
              String(s.status ?? '-'),
              String(s.imageUrl ?? '-'),
              String(s.cpu ?? '-'),
              `${s.memory ?? '-'}MB`,
              String(s.endpointUrl ?? '-'),
            ]),
          );
        }
        await reportCliUsage('cli.compute.list', true);
      } catch (err) {
        await reportCliUsage('cli.compute.list', false);
        handleError(err, json);
      }
    });
}
