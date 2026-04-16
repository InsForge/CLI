import type { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import * as clack from '@clack/prompts';
import archiver from 'archiver';
import { ossFetch } from '../../lib/api/oss.js';
import { getProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError, getDeploymentError, formatFetchError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import type {
  CreateDeploymentResponse,
  CreateDirectDeploymentRequest,
  CreateDirectDeploymentResponse,
  DeploymentManifestFile,
  DeploymentManifestFileEntry,
  DeploymentSchema,
  ProjectConfig,
  StartDeploymentRequest,
} from '../../types.js';
import { reportCliUsage } from '../../lib/skills.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 300_000;
const DIRECT_UPLOAD_CONCURRENCY = 8;

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

type LocalDeploymentFile = DeploymentManifestFileEntry & {
  absolutePath: string;
};

class DirectDeploymentUnsupportedError extends Error {
  constructor() {
    super('Direct deployment endpoints are not available on this backend');
    this.name = 'DirectDeploymentUnsupportedError';
  }
}

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

function isInsforgeCloudOssHost(ossHost: string): boolean {
  try {
    return new URL(ossHost).hostname.endsWith('.insforge.app');
  } catch {
    return false;
  }
}

function normalizeRelativePath(sourceDir: string, absolutePath: string): string {
  return path.relative(sourceDir, absolutePath).split(path.sep).join('/').replace(/\\/g, '/');
}

async function hashFile(filePath: string): Promise<{ sha: string; size: number }> {
  const hash = createHash('sha1');
  let size = 0;

  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    hash.update(buffer);
  }

  return { sha: hash.digest('hex'), size };
}

async function collectDeploymentFiles(sourceDir: string): Promise<LocalDeploymentFile[]> {
  const files: LocalDeploymentFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const normalizedPath = normalizeRelativePath(sourceDir, absolutePath);

      if (!normalizedPath || shouldExclude(normalizedPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const { sha, size } = await hashFile(absolutePath);
      files.push({
        absolutePath,
        path: normalizedPath,
        sha,
        size,
      });
    }
  }

  await walk(sourceDir);
  return files;
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

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function createDirectDeploymentSession(
  config: ProjectConfig,
  files: CreateDirectDeploymentRequest['files'],
): Promise<CreateDirectDeploymentResponse> {
  const url = `${config.oss_host}/api/deployments/direct`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.api_key}`,
      },
      body: JSON.stringify({ files }),
    });
  } catch (error) {
    throw new CLIError(formatFetchError(error, url));
  }

  if (response.status === 404) {
    throw new DirectDeploymentUnsupportedError();
  }

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      nextActions?: string;
    };

    let message = err.message ?? err.error ?? `OSS request failed: ${response.status}`;
    if (err.nextActions) {
      message += `\n${err.nextActions}`;
    }

    throw new CLIError(message);
  }

  const payload = (await response.json()) as Partial<CreateDirectDeploymentResponse>;
  if (!payload.id || !Array.isArray(payload.files)) {
    throw new CLIError('Unexpected response from direct deployment create endpoint.');
  }

  return payload as CreateDirectDeploymentResponse;
}

async function uploadDirectDeploymentFile(
  deploymentId: string,
  manifestFile: DeploymentManifestFile,
  localFile: LocalDeploymentFile,
): Promise<void> {
  const requestInit = {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(localFile.size),
    },
    body: createReadStream(localFile.absolutePath),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' };

  await ossFetch(
    `/api/deployments/${encodeURIComponent(deploymentId)}/files/${encodeURIComponent(manifestFile.fileId)}/content`,
    requestInit,
  );
}

async function startDirectDeployment(
  deploymentId: string,
  startBody: StartDeploymentRequest,
): Promise<void> {
  const response = await ossFetch(`/api/deployments/${encodeURIComponent(deploymentId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(startBody),
  });

  await response.json();
}

async function pollDeployment(
  deploymentId: string,
  spinner: ReturnType<typeof clack.spinner> | null | undefined,
  syncBeforeRead: boolean,
): Promise<DeployProjectResult> {
  spinner?.message('Building and deploying...');
  const startTime = Date.now();
  let deployment: DeploymentSchema | null = null;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      if (syncBeforeRead) {
        await ossFetch(`/api/deployments/${deploymentId}/sync`, { method: 'POST' });
      }

      const statusRes = await ossFetch(`/api/deployments/${deploymentId}`);
      deployment = (await statusRes.json()) as DeploymentSchema;
      const status = deployment.status.toUpperCase();

      if (status === 'READY') {
        break;
      }
      if (status === 'ERROR' || status === 'CANCELED') {
        spinner?.stop('Deployment failed');
        throw new CLIError(
          getDeploymentError(deployment.metadata) ?? `Deployment failed with status: ${deployment.status}`,
        );
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      spinner?.message(`Building and deploying... (${elapsed}s, status: ${deployment.status})`);
    } catch (err) {
      if (err instanceof CLIError) throw err;
      // Ignore transient fetch errors during polling
    }
  }

  const isReady = deployment?.status.toUpperCase() === 'READY';
  const liveUrl = isReady ? (deployment?.url ?? null) : null;

  return { deploymentId, deployment, isReady, liveUrl };
}

async function deployProjectDirect(
  opts: DeployProjectOptions,
  config: ProjectConfig,
): Promise<DeployProjectResult> {
  const { sourceDir, startBody = {}, spinner } = opts;

  spinner?.start('Scanning source files...');
  const localFiles = await collectDeploymentFiles(sourceDir);
  if (localFiles.length === 0) {
    throw new CLIError('No deployable files found in the source directory.');
  }

  spinner?.message('Creating deployment...');
  const createResult = await createDirectDeploymentSession(
    config,
    localFiles.map(({ path: relativePath, sha, size }) => ({ path: relativePath, sha, size })),
  );

  const localFileByPath = new Map(localFiles.map((file) => [file.path, file]));

  const pendingFiles = createResult.files.filter((file) => !file.uploadedAt);

  spinner?.message(`Uploading ${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'}...`);
  await runWithConcurrency(pendingFiles, DIRECT_UPLOAD_CONCURRENCY, async (manifestFile) => {
    const localFile = localFileByPath.get(manifestFile.path);
    if (!localFile) {
      throw new CLIError(`Backend returned an unknown file path: ${manifestFile.path}`);
    }
    if (localFile.sha !== manifestFile.sha || localFile.size !== manifestFile.size) {
      throw new CLIError(`Backend file metadata mismatch for: ${manifestFile.path}`);
    }

    await uploadDirectDeploymentFile(createResult.id, manifestFile, localFile);
  });

  spinner?.message('Starting deployment...');
  await startDirectDeployment(createResult.id, startBody);

  return await pollDeployment(createResult.id, spinner, !isInsforgeCloudOssHost(config.oss_host));
}

async function deployProjectLegacy(
  opts: DeployProjectOptions,
): Promise<DeployProjectResult> {
  const { sourceDir, startBody = {}, spinner } = opts;

  spinner?.message('Creating deployment...');
  const createRes = await ossFetch('/api/deployments', { method: 'POST' });
  const { id: deploymentId, uploadUrl, uploadFields } =
    (await createRes.json()) as CreateDeploymentResponse;

  spinner?.message('Compressing source files...');
  const zipBuffer = await createZipBuffer(sourceDir);

  spinner?.message('Uploading...');
  const formData = new FormData();
  for (const [key, value] of Object.entries(uploadFields)) {
    formData.append(key, value);
  }
  formData.append('file', new Blob([zipBuffer], { type: 'application/zip' }), 'deployment.zip');

  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
  if (!uploadRes.ok) {
    const uploadErr = await uploadRes.text();
    throw new CLIError(`Failed to upload: ${uploadErr}`);
  }

  spinner?.message('Starting deployment...');
  const startRes = await ossFetch(`/api/deployments/${deploymentId}/start`, {
    method: 'POST',
    body: JSON.stringify(startBody),
  });
  await startRes.json();

  return await pollDeployment(deploymentId, spinner, false);
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
 * Core deploy logic: direct upload -> start -> poll.
 * Falls back to the legacy zip upload flow when the backend does not expose
 * the direct deployment endpoints yet.
 */
export async function deployProject(opts: DeployProjectOptions): Promise<DeployProjectResult> {
  const config = getProjectConfig();
  if (!config) {
    throw new ProjectNotLinkedError();
  }

  try {
    return await deployProjectDirect(opts, config);
  } catch (error) {
    if (!(error instanceof DirectDeploymentUnsupportedError)) {
      throw error;
    }

    opts.spinner?.message('Direct deployment is not available on this backend. Falling back to the legacy zip upload flow...');
    return await deployProjectLegacy(opts);
  }
}

export function registerDeploymentsDeployCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('deploy [directory]')
    .description('Deploy a frontend project to Vercel')
    .option('--env <vars>', 'Environment variables as JSON (e.g. {"KEY":"value"})')
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
          throw new CLIError(
            `"${dirName}" is an excluded directory and cannot be used as a deploy source. Please specify your project root or output directory instead.`,
          );
        }

        const spinner = !json ? clack.spinner() : null;

        // Parse env/meta from CLI flags
        const startBody: StartDeploymentRequest = {};
        if (opts.env) {
          try {
            const parsed = JSON.parse(opts.env) as unknown;
            if (Array.isArray(parsed)) {
              startBody.envVars = parsed as Array<{ key: string; value: string }>;
            } else if (parsed && typeof parsed === 'object') {
              startBody.envVars = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
                key,
                value: String(value),
              }));
            } else {
              throw new CLIError('Invalid --env JSON. Expected an object or array.');
            }
          } catch {
            throw new CLIError('Invalid --env JSON.');
          }
        }
        if (opts.meta) {
          try {
            startBody.meta = JSON.parse(opts.meta);
          } catch {
            throw new CLIError('Invalid --meta JSON.');
          }
        }

        const result = await deployProject({ sourceDir, startBody, spinner });

        if (result.isReady) {
          spinner?.stop('Deployment complete');
          if (json) {
            outputJson(result.deployment);
          } else {
            if (result.liveUrl) {
              clack.log.success(`Live at: ${result.liveUrl}`);
            }
            clack.log.info(`Deployment ID: ${result.deploymentId}`);
          }
        } else {
          spinner?.stop('Deployment is still building');
          if (json) {
            outputJson({
              id: result.deploymentId,
              status: result.deployment?.status ?? 'building',
              timedOut: true,
            });
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
