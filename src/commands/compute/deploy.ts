import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

// `compute deploy` deploys a pre-built Docker image as a compute service.
// Image-only by design — build the image with your own toolchain (local
// Docker), push to a registry, then deploy via:
//   compute deploy --image ghcr.io/<you>/<app>:<tag> --name <app> --port <port>
export function registerComputeDeployCommand(computeCmd: Command): void {
  computeCmd
    .command('deploy')
    .description(
      'Deploy a pre-built Docker image as a compute service. ' +
        'Build the image locally with Docker, push it to a registry, then deploy via --image.'
    )
    .requiredOption('--name <name>', 'Service name (DNS-safe, e.g. my-api)')
    .requiredOption('--image <url>', 'Docker image URL (e.g. ghcr.io/you/app:v1, nginx:alpine)')
    .option('--port <port>', 'Container port', '8080')
    .option(
      '--cpu <tier>',
      'CPU tier in <kind>-<N>x format (e.g. shared-1x, performance-2x)',
      'shared-1x'
    )
    .option('--memory <mb>', 'Memory in MB (any positive integer)', '512')
    .option('--region <region>', 'Fly.io region (e.g. iad, sin, lhr)', 'iad')
    .option('--env <json>', 'Environment variables as a JSON object')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const port = Number(opts.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CLIError(`Invalid --port value: ${opts.port} (expected integer 1-65535)`);
        }
        const memory = Number(opts.memory);
        if (!Number.isInteger(memory) || memory <= 0) {
          throw new CLIError(`Invalid --memory value: ${opts.memory} (expected positive integer MB)`);
        }

        const body: Record<string, unknown> = {
          name: opts.name,
          imageUrl: opts.image,
          port,
          cpu: opts.cpu,
          memory,
          region: opts.region,
        };
        if (opts.env) {
          let parsedEnv: unknown;
          try {
            parsedEnv = JSON.parse(opts.env);
          } catch {
            throw new CLIError('Invalid JSON for --env');
          }
          if (!parsedEnv || typeof parsedEnv !== 'object' || Array.isArray(parsedEnv)) {
            throw new CLIError('Invalid --env: expected a JSON object like {"KEY":"value"}');
          }
          body.envVars = parsedEnv;
        }

        const res = await ossFetch('/api/compute/services', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const service = (await res.json()) as Record<string, unknown>;

        if (json) {
          outputJson(service);
        } else {
          outputSuccess(`Service "${service.name}" deployed [${service.status}]`);
          if (service.endpointUrl) {
            console.log(`  Endpoint: ${service.endpointUrl}`);
          }
        }
        await reportCliUsage('cli.compute.deploy', true);
      } catch (err) {
        await reportCliUsage('cli.compute.deploy', false);
        handleError(err, json);
      }
    });
}
