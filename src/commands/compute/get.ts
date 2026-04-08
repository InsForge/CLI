import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerComputeGetCommand(computeCmd: Command): void {
  computeCmd
    .command('get <id>')
    .description('Get details of a compute service')
    .action(async (id: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch(`/api/compute/services/${encodeURIComponent(id)}`);
        const service = await res.json() as Record<string, unknown>;

        if (json) {
          outputJson(service);
        } else {
          outputInfo(`Name:      ${service.name}`);
          outputInfo(`ID:        ${service.id}`);
          outputInfo(`Status:    ${service.status}`);
          outputInfo(`Image:     ${service.imageUrl}`);
          outputInfo(`CPU:       ${service.cpu}`);
          outputInfo(`Memory:    ${service.memory}MB`);
          outputInfo(`Region:    ${service.region}`);
          outputInfo(`Endpoint:  ${service.endpointUrl ?? 'n/a'}`);
          outputInfo(`Created:   ${service.createdAt}`);
        }
        await reportCliUsage('cli.compute.get', true);
      } catch (err) {
        await reportCliUsage('cli.compute.get', false);
        handleError(err, json);
      }
    });
}
