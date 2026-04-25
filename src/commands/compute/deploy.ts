import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

// `compute deploy` deploys a pre-built Docker image as a compute service.
//
// Image-only by design. InsForge is a deployment platform; building images
// is delegated to the user's own toolchain. Two paths to produce one:
//   1. Local: `docker build -t ghcr.io/<you>/<app>:<tag> .` then push
//   2. CI:    Use a GitHub Actions template that builds + pushes on commit
//             (see https://github.com/InsForge/insforge-skills for a starter)
// Then deploy via:
//   compute deploy --image ghcr.io/<you>/<app>:<tag> --name <app> --port <port>
export function registerComputeDeployCommand(computeCmd: Command): void {
  computeCmd
    .command('deploy')
    .description(
      'Deploy a pre-built Docker image as a compute service. ' +
        'Build the image with your own toolchain (local Docker, GitHub Actions, etc.), ' +
        'push it to a registry, then deploy via --image.'
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
