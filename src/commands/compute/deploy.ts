import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { tarDir, uploadPresigned } from '../../lib/upload.js';

// `compute deploy` has two modes:
//
//   1. Image mode (--image <url>):
//      Deploy a pre-built image from any registry. Same as v1.
//
//   2. Source mode ([dir]):
//      Tar the directory, upload source.tgz directly to InsForge's S3
//      via a presigned PUT URL, cloud builds it on AWS CodeBuild, then
//      deploys. NO local Docker required.
//
// Bytes never proxy through OSS or cloud — laptop -> S3 direct via the
// presigned URL.
export function registerComputeDeployCommand(computeCmd: Command): void {
  computeCmd
    .command('deploy [dir]')
    .description(
      'Deploy a compute service. Two modes:\n' +
        '  compute deploy <dir> --name <name>             (source mode — tars dir, server builds Dockerfile)\n' +
        '  compute deploy --image <url> --name <name>     (image mode — deploys pre-built image)'
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
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
          ) {
            throw new CLIError(
              '--env must be a JSON object like {"KEY":"value"}'
            );
          }
          envVars = parsed as Record<string, string>;
        }

        const body: Record<string, unknown> = {
          name: opts.name,
          port,
          cpu: opts.cpu,
          memory,
          region: opts.region,
        };
        if (envVars) body.envVars = envVars;

        if (dir) {
          // ─── Source mode ─────────────────────────────────────────────
          const absDir = resolve(dir);
          const dockerfilePath = `${absDir}/Dockerfile`;
          if (!existsSync(dockerfilePath)) {
            throw new CLIError(
              `No Dockerfile at ${dockerfilePath}.\n` +
                `  Either:\n` +
                `   • Create one (ask your AI agent — see the insforge-cli skill)\n` +
                `   • Use --image <url> to deploy a pre-built image instead`
            );
          }

          if (!json) outputInfo(`Detected Dockerfile at ${dockerfilePath}`);

          // 1. Get presigned upload URL from cloud
          if (!json) outputInfo('Requesting upload credentials...');
          const credsRes = await ossFetch('/api/compute/services/build-creds', {
            method: 'POST',
            body: JSON.stringify({ name: opts.name }),
          });
          if (credsRes.status === 429) {
            throw new CLIError(
              'Another build for this project is already in progress. Try again shortly.'
            );
          }
          const creds = (await credsRes.json()) as {
            sourceKey: string;
            uploadUrl: string;
            imageTag: string;
            expiresAt: string;
          };

          // 2. Tar the directory
          if (!json) outputInfo('Tarring source...');
          const tarball = await tarDir(absDir);
          if (!json) {
            outputInfo(
              `Uploading source (${(tarball.length / 1024).toFixed(1)} KB)...`
            );
          }

          // 3. Upload directly to S3 via presigned URL
          await uploadPresigned(creds.uploadUrl, tarball);

          body.sourceKey = creds.sourceKey;
          body.imageTag = creds.imageTag;

          if (!json) {
            outputInfo(
              'Source uploaded. Building on AWS CodeBuild + deploying (~60-120s)...'
            );
          }
        } else {
          body.imageUrl = opts.image;
        }

        // Look up existing service by name. If found → PATCH (update),
        // else → POST (create). Same body shape (cloud builds first if
        // sourceKey is present, regardless of POST vs PATCH).
        const listRes = await ossFetch('/api/compute/services');
        const existing = ((await listRes.json()) as Array<{ id: string; name: string }>)
          .find((s) => s.name === opts.name);

        let res;
        if (existing) {
          if (!json) outputInfo(`Found existing service "${opts.name}", updating...`);
          // For PATCH, name is implicit (in the URL via id); body is the update payload
          const { name: _omit, ...updateBody } = body;
          void _omit;
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
