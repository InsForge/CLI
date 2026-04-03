import type { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as clack from '@clack/prompts';
import archiver from 'archiver';
import { ossFetch } from '../../lib/api/oss.js';
import { getProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError, getDeploymentError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import type { CreateDeploymentResponse, StartDeploymentRequest, DeploymentSchema } from '../../types.js';
import { reportCliUsage } from '../../lib/skills.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 300_000;

const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.next',
  '.env',
  '.env.local',
  'dist',
  'build',
  '.DS_Store',
  '.insforge',
  // IDE and AI agent configs
  '.claude',
  '.agents',
  '.augment',
  '.kilocode',
  '.kiro',
  '.qoder',
  '.qwen',
  '.roo',
  '.trae',
  '.windsurf',
  '.vercel',
  '.turbo',
  '.cache',
  'skills',
  'coverage',
];

function shouldExclude(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  for (const pattern of EXCLUDE_PATTERNS) {
    if (
      normalized === pattern ||
      normalized.startsWith(pattern + '/') ||
      normalized.endsWith('/' + pattern) ||
      normalized.includes('/' + pattern + '/')
    ) {
      return true;
    }
  }
  if (normalized.endsWith('.log')) return true;
  return false;
}

async function createZipBuffer(sourceDir: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', (err: Error) => reject(err));

    archive.directory(sourceDir, false, (entry) => {
      if (shouldExclude(entry.name)) return false;
      return entry;
    });

    void archive.finalize();
  });
}

export interface DeployProjectOptions {
  sourceDir: string;
  startBody?: StartDeploymentRequest;
  spinner?: ReturnType<typeof clack.spinner> | null;
}

export interface DeployProjectResult {
  deploymentId: string;
  deployment: DeploymentSchema | null;
  isReady: boolean;
  liveUrl: string | null;
}

/**
 * Core deploy logic: zip → upload → start → poll.
 * Reusable from both the `deploy` command and `create` command.
 */
export async function deployProject(opts: DeployProjectOptions): Promise<DeployProjectResult> {
  const { sourceDir, startBody = {}, spinner: s } = opts;

  // Step 1: Create deployment to get presigned upload URL
  s?.start('Creating deployment...');
  const createRes = await ossFetch('/api/deployments', { method: 'POST' });
  const { id: deploymentId, uploadUrl, uploadFields } =
    (await createRes.json()) as CreateDeploymentResponse;

  // Step 2: Create zip
  s?.message('Compressing source files...');
  const zipBuffer = await createZipBuffer(sourceDir);

  // Step 3: Upload zip to presigned URL
  s?.message('Uploading...');
  const formData = new FormData();
  for (const [key, value] of Object.entries(uploadFields)) {
    formData.append(key, value);
  }
  formData.append(
    'file',
    new Blob([zipBuffer], { type: 'application/zip' }),
    'deployment.zip',
  );

  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
  if (!uploadRes.ok) {
    const uploadErr = await uploadRes.text();
    throw new CLIError(`Failed to upload: ${uploadErr}`);
  }

  // Step 4: Start the deployment
  s?.message('Starting deployment...');
  const startRes = await ossFetch(`/api/deployments/${deploymentId}/start`, {
    method: 'POST',
    body: JSON.stringify(startBody),
  });
  await startRes.json();

  // Step 5: Poll for deployment status
  s?.message('Building and deploying...');
  const startTime = Date.now();
  let deployment: DeploymentSchema | null = null;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const statusRes = await ossFetch(`/api/deployments/${deploymentId}`);
      deployment = (await statusRes.json()) as DeploymentSchema;
      const status = deployment.status.toUpperCase();

      if (status === 'READY') {
        break;
      }
      if (status === 'ERROR' || status === 'CANCELED') {
        s?.stop('Deployment failed');
        throw new CLIError(getDeploymentError(deployment.metadata) ?? `Deployment failed with status: ${deployment.status}`);
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      s?.message(`Building and deploying... (${elapsed}s, status: ${deployment.status})`);
    } catch (err) {
      if (err instanceof CLIError) throw err;
      // Ignore transient fetch errors during polling
    }
  }

  const isReady = deployment?.status.toUpperCase() === 'READY';
  const liveUrl = isReady ? (deployment?.url ?? null) : null;

  return { deploymentId, deployment, isReady, liveUrl };
}

export function registerDeploymentsDeployCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('deploy [directory]')
    .description('Deploy a frontend project to Vercel')
    .option('--env <vars>', 'Environment variables as JSON (e.g. \'{"KEY":"value"}\')')
    .option('--meta <meta>', 'Deployment metadata as JSON')
    .action(async (directory: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        // Resolve source directory
        const sourceDir = path.resolve(directory ?? '.');
        const stats = await fs.stat(sourceDir).catch(() => null);
        if (!stats?.isDirectory()) {
          throw new CLIError(`"${sourceDir}" is not a valid directory.`);
        }

        // Reject excluded directories as deploy source
        const dirName = path.basename(sourceDir);
        if (EXCLUDE_PATTERNS.includes(dirName)) {
          throw new CLIError(`"${dirName}" is an excluded directory and cannot be used as a deploy source. Please specify your project root or output directory instead.`);
        }

        const s = !json ? clack.spinner() : null;

        // Parse env/meta from CLI flags
        const startBody: StartDeploymentRequest = {};
        if (opts.env) {
          try {
            const parsed = JSON.parse(opts.env) as Record<string, string>;
            if (Array.isArray(parsed)) {
              startBody.envVars = parsed;
            } else {
              startBody.envVars = Object.entries(parsed).map(([key, value]) => ({ key, value }));
            }
          } catch { throw new CLIError('Invalid --env JSON.'); }
        }
        if (opts.meta) {
          try { startBody.meta = JSON.parse(opts.meta); } catch { throw new CLIError('Invalid --meta JSON.'); }
        }

        const result = await deployProject({ sourceDir, startBody, spinner: s });

        if (result.isReady) {
          s?.stop('Deployment complete');
          if (json) {
            outputJson(result.deployment);
          } else {
            if (result.liveUrl) {
              clack.log.success(`Live at: ${result.liveUrl}`);
            }
            clack.log.info(`Deployment ID: ${result.deploymentId}`);
          }
        } else {
          s?.stop('Deployment is still building');
          if (json) {
            outputJson({ id: result.deploymentId, status: result.deployment?.status ?? 'building', timedOut: true });
          } else {
            clack.log.info(`Deployment ID: ${result.deploymentId}`);
            clack.log.warn('Deployment did not finish within 5 minutes.');
            clack.log.info(`Check status with: npx @insforge/cli deployments status ${result.deploymentId}`);
          }
        }
        await reportCliUsage('cli.deployments.deploy', true);
      } catch (err) {
        await reportCliUsage('cli.deployments.deploy', false);
        handleError(err, json);
      }
    });
}
