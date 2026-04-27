import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import {
  ensureDockerAvailable,
  dockerBuild,
  dockerLogin,
  dockerPush,
} from '../../lib/docker.js';

// `compute deploy` has two modes:
//
//   1. Image mode (--image <url>):
//      Deploy a pre-built image from any registry. Same as v1.
//
//   2. Source mode ([dir]) — Path A (compute v3.1):
//      CLI runs docker build + push to registry.fly.io using a per-app
//      deploy token minted by the cloud. Cloud then launches the machine
//      pointing at the freshly-pushed image. Requires Docker locally.
//      Image bytes never proxy through OSS or cloud.
export function registerComputeDeployCommand(computeCmd: Command): void {
  computeCmd
    .command('deploy [dir]')
    .description(
      'Deploy a compute service. Two modes:\n' +
        '  compute deploy <dir> --name <name>             (source mode — local docker build + push, requires Docker)\n' +
        '  compute deploy --image <url> --name <name>     (image mode — deploys pre-built image, no Docker required)'
    )
    .requiredOption('--name <name>', 'Service name (DNS-safe, e.g. my-api)')
    .option('--image <url>', 'Pre-built image URL (image mode)')
    .option('--port <port>', 'Container port', '8080')
    .option(
      '--cpu <tier>',
      'CPU tier in <kind>-<N>x format (e.g. shared-1x, performance-2x)',
      'shared-1x'
    )
    .option('--memory <mb>', 'Memory in MB', '512')
    .option('--region <region>', 'Fly.io region', 'iad')
    .option('--env <json>', 'Env vars as JSON object')
    .action(async (dir: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (dir && opts.image) {
          throw new CLIError('Cannot use both [dir] and --image — pick one mode.');
        }
        if (!dir && !opts.image) {
          throw new CLIError(
            'Must provide either [dir] (source mode) or --image <url> (image mode).'
          );
        }

        // Shared validation
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CLIError(`Invalid --port: ${opts.port}`);
        }
        const memory = Number(opts.memory);
        if (!Number.isInteger(memory) || memory <= 0) {
          throw new CLIError(`Invalid --memory: ${opts.memory}`);
        }
        let envVars: Record<string, string> | undefined;
        if (opts.env) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(opts.env);
          } catch {
            throw new CLIError('Invalid JSON for --env');
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new CLIError('--env must be a JSON object like {"KEY":"value"}');
          }
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v !== 'string') {
              throw new CLIError(
                `--env values must be strings — got ${typeof v} for key "${k}"`
              );
            }
          }
          envVars = parsed as Record<string, string>;
        }

        const baseBody: Record<string, unknown> = {
          name: opts.name,
          port,
          cpu: opts.cpu,
          memory,
          region: opts.region,
        };
        if (envVars) baseBody.envVars = envVars;

        // ─── Image mode ─────────────────────────────────────────────────
        if (!dir) {
          const body: Record<string, unknown> = { ...baseBody, imageUrl: opts.image };

          // List → find by name → POST or PATCH
          const listRes = await ossFetch('/api/compute/services');
          const existing = ((await listRes.json()) as Array<{ id: string; name: string }>).find(
            (s) => s.name === opts.name
          );

          let res;
          if (existing) {
            if (!json) outputInfo(`Found existing service "${opts.name}", updating...`);
            const updateBody: Record<string, unknown> = { ...body };
            delete updateBody.name;
            res = await ossFetch(`/api/compute/services/${encodeURIComponent(existing.id)}`, {
              method: 'PATCH',
              body: JSON.stringify(updateBody),
            });
          } else {
            res = await ossFetch('/api/compute/services', {
              method: 'POST',
              body: JSON.stringify(body),
            });
          }
          const service = (await res.json()) as Record<string, unknown>;

          if (json) {
            outputJson(service);
          } else {
            const verb = existing ? 'updated' : 'deployed';
            outputSuccess(`Service "${service.name}" ${verb} [${service.status}]`);
            if (service.endpointUrl) console.log(`  Endpoint: ${service.endpointUrl}`);
          }
          await reportCliUsage('cli.compute.deploy', true);
          return;
        }

        // ─── Source mode (Path A) ───────────────────────────────────────
        const absDir = resolve(dir);
        const dockerfilePath = join(absDir, 'Dockerfile');
        if (!existsSync(dockerfilePath)) {
          throw new CLIError(
            `No Dockerfile at ${dockerfilePath}.\n` +
              `  Either:\n` +
              `   • Create one (ask your AI agent — see the insforge-cli skill)\n` +
              `   • Use --image <url> to deploy a pre-built image instead`
          );
        }
        ensureDockerAvailable();

        if (!json) outputInfo(`Detected Dockerfile at ${dockerfilePath}`);

        // 1. Resolve service: list → find by name → /deploy if missing
        const listRes = await ossFetch('/api/compute/services');
        const existing = ((await listRes.json()) as Array<{
          id: string;
          name: string;
          flyAppId?: string | null;
        }>).find((s) => s.name === opts.name);

        let serviceId: string;
        let flyAppId: string;
        if (existing) {
          if (!existing.flyAppId) {
            throw new CLIError(
              `Service "${opts.name}" exists but has no Fly app yet. Delete it and redeploy.`
            );
          }
          serviceId = existing.id;
          flyAppId = existing.flyAppId;
          if (!json) outputInfo(`Found existing service "${opts.name}" (${flyAppId}), updating...`);
        } else {
          if (!json) outputInfo(`Creating service "${opts.name}"...`);
          const prepareRes = await ossFetch('/api/compute/services/deploy', {
            method: 'POST',
            body: JSON.stringify(baseBody),
          });
          const prepared = (await prepareRes.json()) as {
            id: string;
            flyAppId: string;
          };
          serviceId = prepared.id;
          flyAppId = prepared.flyAppId;
          if (!json) outputInfo(`Created Fly app ${flyAppId}`);
        }

        // 2. Mint per-app deploy token (20-min TTL, scoped to this app only)
        if (!json) outputInfo('Requesting deploy token...');
        const tokenRes = await ossFetch(
          `/api/compute/services/${encodeURIComponent(serviceId)}/deploy-token`,
          { method: 'POST' }
        );
        const tokenJson = (await tokenRes.json()) as { token: string; expirySeconds: number };

        // 3. Build + push
        const tag = `cli-${Date.now()}`;
        const imageRef = `registry.fly.io/${flyAppId}:${tag}`;
        if (!json) outputInfo(`Building image ${imageRef}...`);
        dockerBuild({ dir: absDir, imageRef });

        if (!json) outputInfo('Logging in to registry.fly.io...');
        dockerLogin('registry.fly.io', tokenJson.token);

        if (!json) outputInfo(`Pushing ${imageRef}...`);
        dockerPush(imageRef);

        // 4. Tell cloud the image is ready — launches new machine or
        //    updates existing one. PATCH includes any deploy-affecting
        //    field changes (port/cpu/memory/envVars/region) too.
        if (!json) outputInfo('Launching machine...');
        const updateBody: Record<string, unknown> = {
          imageUrl: imageRef,
          port,
          cpu: opts.cpu,
          memory,
          region: opts.region,
        };
        if (envVars) updateBody.envVars = envVars;

        const finalRes = await ossFetch(
          `/api/compute/services/${encodeURIComponent(serviceId)}`,
          { method: 'PATCH', body: JSON.stringify(updateBody) }
        );
        const service = (await finalRes.json()) as Record<string, unknown>;

        if (json) {
          outputJson(service);
        } else {
          const verb = existing ? 'updated' : 'deployed';
          outputSuccess(`Service "${service.name}" ${verb} [${service.status}]`);
          if (service.endpointUrl) console.log(`  Endpoint: ${service.endpointUrl}`);
          console.log(`  Tip: \`docker rmi ${imageRef}\` to reclaim local disk space`);
        }

        await reportCliUsage('cli.compute.deploy', true);
      } catch (err) {
        await reportCliUsage('cli.compute.deploy', false);
        handleError(err, json);
      }
    });
}
