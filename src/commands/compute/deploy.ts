import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { parseEnvFile } from '../../lib/env-file.js';
import {
  ensureFlyctlAvailable,
  flyctlBuildAndPush,
} from '../../lib/flyctl.js';
import { fetchComputeCapabilities } from '../../lib/compute-capabilities.js';
import { packBuildContext } from '../../lib/build-context.js';

// `compute deploy` has two modes:
//
//   1. Image mode (--image <url>):
//      Deploy a pre-built image from any registry. No flyctl/Docker needed.
//
//   2. Source mode ([dir]) — Path A (compute v3.2):
//      CLI runs `flyctl deploy --remote-only --build-only` against the user's
//      source directory using a per-app, attenuated deploy token minted by
//      the cloud. The remote builder runs on Fly's infrastructure and pushes
//      the image straight to registry.fly.io/<app>:<tag>. The cloud then
//      launches the machine pointing at the freshly-pushed image.
//      Requires `flyctl` on PATH (no Docker daemon needed).
//      The deploy token is scoped to one app + builder/wg, with `else: deny`
//      — it cannot deploy or read anything else in the InsForge Fly org.
export function registerComputeDeployCommand(computeCmd: Command): void {
  computeCmd
    .command('deploy [dir]')
    .description(
      'Deploy a compute service. Two modes:\n' +
        '  compute deploy <dir> --name <name>             (source mode — flyctl remote build + push, requires flyctl on PATH; no Docker needed)\n' +
        '  compute deploy --image <url> --name <name>     (image mode — deploys pre-built image, no flyctl/Docker required)'
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
    .option('--region <region>', 'Region (providers that have more than one)', 'iad')
    .option('--env <json>', 'Env vars as JSON object')
    .option(
      '--env-file <path>',
      'Path to a .env file (KEY=VALUE per line, #-comments + blank lines ok). Mutually exclusive with --env.'
    )
    .option(
      '--protocol <protocol>',
      'Edge protocol: "http" (default) or "tcp" (raw pass-through for Redis, etc.)',
      'http'
    )
    .option(
      '--always-on',
      'Keep the machine running 24/7 instead of scaling to zero when idle (no cold starts; billed for the full uptime)'
    )
    .option(
      '--scale-to-zero',
      'Explicitly switch an always-on service back to scale-to-zero (the default for new services)'
    )
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
        if (opts.protocol !== 'http' && opts.protocol !== 'tcp') {
          throw new CLIError(`Invalid --protocol: ${opts.protocol} (expected "http" or "tcp")`);
        }
        const memory = Number(opts.memory);
        if (!Number.isInteger(memory) || memory <= 0) {
          throw new CLIError(`Invalid --memory: ${opts.memory}`);
        }
        if (opts.env && opts.envFile) {
          throw new CLIError(
            '--env and --env-file are mutually exclusive — pick one source for the env vars.'
          );
        }
        if (opts.alwaysOn && opts.scaleToZero) {
          throw new CLIError('--always-on and --scale-to-zero are mutually exclusive — pick one.');
        }
        // Omitted flags send nothing: create defaults to scale-to-zero
        // server-side, update keeps the service's existing setting.
        const scaleToZero: boolean | undefined = opts.alwaysOn
          ? false
          : opts.scaleToZero
            ? true
            : undefined;
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
        } else if (opts.envFile) {
          envVars = parseEnvFile(resolve(opts.envFile));
        }

        // Ask the backend what its provider can do before shaping the request. A
        // self-hosted Docker daemon has one region and no scale-to-zero, and
        // sending those anyway records a choice that never takes effect.
        const { provider, capabilities } = await fetchComputeCapabilities();
        if (!capabilities.regions && process.argv.includes('--region') && !json) {
          outputInfo(
            `Ignoring --region: the ${provider ?? 'configured'} provider runs on a single host.`
          );
        }
        if (!capabilities.scaleToZero && scaleToZero === false && !json) {
          outputInfo(
            `Ignoring --always-on: the ${provider ?? 'configured'} provider has no ` +
              'scale-to-zero, so services already run continuously.'
          );
        }

        const baseBody: Record<string, unknown> = {
          name: opts.name,
          port,
          cpu: opts.cpu,
          memory,
          // Omitted where it means nothing, so the stored row does not claim a
          // region the provider never honoured.
          ...(capabilities.regions ? { region: opts.region } : {}),
        };
        if (envVars) baseBody.envVars = envVars;
        if (opts.protocol === 'tcp') baseBody.protocol = 'tcp';
        if (scaleToZero !== undefined && capabilities.scaleToZero) {
          baseBody.scaleToZero = scaleToZero;
        }

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
            if (opts.protocol === 'tcp') updateBody.protocol = 'tcp';
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

          await trackCommandUsage('compute', 'deploy', true);

          if (json) {
            outputJson(service);
          } else {
            const verb = existing ? 'updated' : 'deployed';
            outputSuccess(`Service "${service.name}" ${verb} [${service.status}]`);
            if (service.endpointUrl && opts.protocol === 'tcp') {
              const host = String(service.endpointUrl).replace(/^https?:\/\//, '');
              console.log(`  Endpoint: ${host}:${service.port} (connect with <scheme>://${host}:${service.port})`);
              console.log(`  Note: TCP services are reachable from the public internet.`);
              console.log(`        Configure auth on your container (e.g. redis --requirepass <secret>).`);
            } else if (service.endpointUrl) {
              console.log(`  Endpoint: ${service.endpointUrl}`);
            }
            if (service.port !== undefined) console.log(`  Port: ${service.port} (container must listen on this port)`);
            if (service.scaleToZero === false) console.log(`  Always-on: scale-to-zero disabled (machine runs 24/7; pass --scale-to-zero to revert)`);
          }
          await reportCliUsage('cli.compute.deploy', true);
          return;
        }

        // ─── Source mode ────────────────────────────────────────────────
        const absDir = resolve(dir);
        // Provider capability first: when it cannot build at all, whether a
        // Dockerfile exists is beside the point.
        if (capabilities.sourceBuild === 'none') {
          throw new CLIError(
            `The ${provider ?? 'configured'} compute provider cannot build from source.\n` +
              `  Build the image yourself and deploy it with --image <url>.`
          );
        }
        const dockerfilePath = join(absDir, 'Dockerfile');
        if (!existsSync(dockerfilePath)) {
          throw new CLIError(
            `No Dockerfile at ${dockerfilePath}.\n` +
              `  Either:\n` +
              `   • Create one (ask your AI agent — see the insforge-cli skill)\n` +
              `   • Use --image <url> to deploy a pre-built image instead`
          );
        }
        if (!json) outputInfo(`Detected Dockerfile at ${dockerfilePath}`);

        // ─── Source mode via context upload (self-hosted Docker) ─────────
        //
        // The backend owns the build here because it has the daemon: upload the
        // context and it builds, tags and deploys in one call. So there is no
        // deploy token to mint, no flyctl on PATH, and no follow-up PATCH.
        if (capabilities.sourceBuild === 'context-upload') {
          const listRes = await ossFetch('/api/compute/services');
          const found = ((await listRes.json()) as Array<{ id: string; name: string }>).find(
            (s) => s.name === opts.name
          );

          let serviceId: string;
          if (found) {
            serviceId = found.id;
            if (!json) outputInfo(`Found existing service "${opts.name}", rebuilding...`);
          } else {
            if (!json) outputInfo(`Creating service "${opts.name}"...`);
            const prepareRes = await ossFetch('/api/compute/services/deploy', {
              method: 'POST',
              body: JSON.stringify(baseBody),
            });
            serviceId = ((await prepareRes.json()) as { id: string }).id;
          }

          if (!json) outputInfo('Packing build context...');
          const { tar, fileCount } = await packBuildContext(absDir);
          if (!json) {
            const mb = (tar.length / 1024 / 1024).toFixed(1);
            outputInfo(`Uploading ${fileCount} file(s), ${mb} MB...`);
          }

          let buildRes;
          try {
            buildRes = await ossFetch(
              `/api/compute/services/${encodeURIComponent(serviceId)}/build`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-tar' },
                body: tar,
              }
            );
          } catch (buildErr) {
            // Same rollback rule as the flyctl path: clean up a service this
            // command created, leave an existing one running.
            if (!found) {
              await ossFetch(`/api/compute/services/${encodeURIComponent(serviceId)}`, {
                method: 'DELETE',
              }).catch(() => undefined);
              if (!json) outputInfo(`Rolled back service "${opts.name}" after build failure.`);
            }
            throw buildErr;
          }

          const built = (await buildRes.json()) as {
            service?: Record<string, unknown>;
            imageTag: string;
            logs?: string[];
          };
          if (json) {
            outputJson(built);
          } else {
            for (const line of built.logs ?? []) {
              console.log(`  ${String(line).trimEnd()}`);
            }
            const svc = built.service ?? {};
            const status = String(svc.status ?? 'running');
            outputSuccess(`Service "${String(svc.name ?? opts.name)}" deployed [${status}]`);
            console.log(`  Image: ${built.imageTag}`);
            if (svc.endpointUrl) {
              console.log(`  Endpoint: ${String(svc.endpointUrl)}`);
            } else {
              console.log(`  No public endpoint — reachable on the project's internal network.`);
            }
          }
          await reportCliUsage('cli.compute.deploy', true);
          return;
        }

        // ─── Source mode via flyctl remote build (Fly.io) ────────────────
        ensureFlyctlAvailable();

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

        // 3. Remote build + push (no local Docker daemon needed).
        //    flyctl ships the build context to Fly's remote builder, builds
        //    there, and pushes to registry.fly.io/<app>:<tag> using the
        //    attenuated FLY_API_TOKEN we just received.
        //    If the build fails on a freshly-created service, roll back the
        //    cloud row + Fly app so the user can retry without a manual
        //    `compute delete`. Don't roll back on update of an existing
        //    service — the running machine should survive transient build
        //    errors.
        const imageLabel = `cli-${Date.now()}`;
        if (!json) outputInfo(`Building & pushing on Fly remote builder...`);
        let imageRef: string;
        try {
          ({ imageRef } = await flyctlBuildAndPush({
            dir: absDir,
            appId: flyAppId,
            imageLabel,
            token: tokenJson.token,
            region: opts.region,
            port,
            protocol: opts.protocol === 'tcp' ? 'tcp' : 'http',
          }));
        } catch (buildErr) {
          if (!existing) {
            try {
              await ossFetch(`/api/compute/services/${encodeURIComponent(serviceId)}`, {
                method: 'DELETE',
              });
              if (!json) outputInfo(`Rolled back service "${opts.name}" after build failure.`);
            } catch {
              if (!json) {
                outputInfo(
                  `Build failed and rollback also failed. ` +
                    `Run: npx @insforge/cli compute delete ${serviceId}`
                );
              }
            }
          }
          throw buildErr;
        }

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
        if (opts.protocol === 'tcp') updateBody.protocol = 'tcp';
        if (scaleToZero !== undefined) updateBody.scaleToZero = scaleToZero;

        const finalRes = await ossFetch(
          `/api/compute/services/${encodeURIComponent(serviceId)}`,
          { method: 'PATCH', body: JSON.stringify(updateBody) }
        );
        const service = (await finalRes.json()) as Record<string, unknown>;

        await trackCommandUsage('compute', 'deploy', true);

        if (json) {
          outputJson(service);
        } else {
          const verb = existing ? 'updated' : 'deployed';
          outputSuccess(`Service "${service.name}" ${verb} [${service.status}]`);
          if (service.endpointUrl && opts.protocol === 'tcp') {
            const host = String(service.endpointUrl).replace(/^https?:\/\//, '');
            console.log(`  Endpoint: ${host}:${service.port} (connect with <scheme>://${host}:${service.port})`);
            console.log(`  Note: TCP services are reachable from the public internet.`);
            console.log(`        Configure auth on your container (e.g. redis --requirepass <secret>).`);
          } else if (service.endpointUrl) {
            console.log(`  Endpoint: ${service.endpointUrl}`);
          }
          if (service.port !== undefined) console.log(`  Port: ${service.port} (container must listen on this port)`);
          if (service.scaleToZero === false) console.log(`  Always-on: scale-to-zero disabled (machine runs 24/7; pass --scale-to-zero to revert)`);
          console.log(`  Image: ${imageRef} (built remotely; no local image to clean up)`);
        }

        await reportCliUsage('cli.compute.deploy', true);
      } catch (err) {
        await reportCliUsage('cli.compute.deploy', false);
        await trackCommandUsage('compute', 'deploy', false, {}, err);
        handleError(err, json);
      }
    });
}
