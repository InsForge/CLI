import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerComputeUpdateCommand(computeCmd: Command): void {
  computeCmd
    .command('update <id>')
    .description('Update a compute service')
    .option('--image <image>', 'Docker image URL')
    .option('--port <port>', 'Container port')
    .option('--cpu <tier>', 'CPU tier')
    .option('--memory <mb>', 'Memory in MB')
    .option('--region <region>', 'Fly.io region')
    .option('--env <json>', 'Environment variables as JSON object')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body: Record<string, unknown> = {};
        if (opts.image) body.imageUrl = opts.image;
        if (opts.port) body.port = Number(opts.port);
        if (opts.cpu) body.cpu = opts.cpu;
        if (opts.memory) body.memory = Number(opts.memory);
        if (opts.region) body.region = opts.region;

        if (opts.env) {
          try {
            body.envVars = JSON.parse(opts.env);
          } catch {
            throw new CLIError('Invalid JSON for --env');
          }
        }

        if (Object.keys(body).length === 0) {
          throw new CLIError('No update fields provided. Use --image, --port, --cpu, --memory, --region, or --env.');
        }

        const res = await ossFetch(`/api/compute/services/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        const service = await res.json() as Record<string, unknown>;

        if (json) {
          outputJson(service);
        } else {
          outputSuccess(`Service "${service.name}" updated [${service.status}]`);
        }
        await reportCliUsage('cli.compute.update', true);
      } catch (err) {
        await reportCliUsage('cli.compute.update', false);
        handleError(err, json);
      }
    });
}
