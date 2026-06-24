import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

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

        await trackCommandUsage('compute', 'get', true);

        if (json) {
          outputJson(service);
        } else {
          // TCP services have no HTTPS listener — show host:port so users can
          // copy the value straight into a protocol-native client.
          const endpoint =
            service.protocol === 'tcp' && service.endpointUrl && service.port
              ? `${String(service.endpointUrl).replace(/^https?:\/\//, '')}:${service.port}`
              : (service.endpointUrl ?? 'n/a');
          outputInfo(`Name:      ${service.name}`);
          outputInfo(`ID:        ${service.id}`);
          outputInfo(`Status:    ${service.status}`);
          outputInfo(`Image:     ${service.imageUrl}`);
          outputInfo(`Protocol:  ${service.protocol ?? 'http'}`);
          outputInfo(`CPU:       ${service.cpu}`);
          outputInfo(`Memory:    ${service.memory}MB`);
          outputInfo(`Region:    ${service.region}`);
          outputInfo(`Endpoint:  ${endpoint}`);
          outputInfo(`Created:   ${service.createdAt}`);
        }
        await reportCliUsage('cli.compute.get', true);
      } catch (err) {
        await reportCliUsage('cli.compute.get', false);
        await trackCommandUsage('compute', 'get', false, {}, err);
        handleError(err, json);
      }
    });
}
