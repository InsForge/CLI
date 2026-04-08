import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerComputeCreateCommand(computeCmd: Command): void {
  computeCmd
    .command('create')
    .description('Create and deploy a compute service')
    .requiredOption('--name <name>', 'Service name (DNS-safe, e.g. my-api)')
    .requiredOption('--image <image>', 'Docker image URL (e.g. nginx:alpine)')
    .option('--port <port>', 'Container port', '8080')
    .option('--cpu <tier>', 'CPU tier (shared-1x, shared-2x, performance-1x, performance-2x, performance-4x)', 'shared-1x')
    .option('--memory <mb>', 'Memory in MB (256, 512, 1024, 2048, 4096, 8192)', '512')
    .option('--region <region>', 'Fly.io region', 'iad')
    .option('--env <json>', 'Environment variables as JSON object')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body: Record<string, unknown> = {
          name: opts.name,
          imageUrl: opts.image,
          port: Number(opts.port),
          cpu: opts.cpu,
          memory: Number(opts.memory),
          region: opts.region,
        };

        if (opts.env) {
          try {
            body.envVars = JSON.parse(opts.env);
          } catch {
            throw new CLIError('Invalid JSON for --env');
          }
        }

        const res = await ossFetch('/api/compute/services', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const service = await res.json() as Record<string, unknown>;

        if (json) {
          outputJson(service);
        } else {
          outputSuccess(`Service "${service.name}" created [${service.status}]`);
          if (service.endpointUrl) {
            console.log(`  Endpoint: ${service.endpointUrl}`);
          }
        }
        await reportCliUsage('cli.compute.create', true);
      } catch (err) {
        await reportCliUsage('cli.compute.create', false);
        handleError(err, json);
      }
    });
}
