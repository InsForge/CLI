import type { Command } from 'commander';
import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  FAKE_ORG_ID,
  FAKE_PROJECT_ID,
  getProjectConfig,
  getProjectConfigFile,
  saveProjectConfig,
} from '../../lib/config.js';
import { probeBackendHealth } from '../../lib/api/oss.js';
import { dockerMemoryMb, ensureDockerReady } from '../../lib/docker.js';
import { upsertEnvFile } from '../../lib/env-writer.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { composePs, composeRunInherit, type ComposeContext } from '../../lib/local/compose.js';
import { ensurePortsAvailable, resolvePorts } from '../../lib/local/ports.js';
import { resolveStack } from '../../lib/local/registry.js';
import { generateSecrets, readSecrets, writeEnvFile } from '../../lib/local/secrets.js';
import {
  composeProjectName,
  readLocalState,
  writeLocalState,
  type LocalPorts,
  type LocalState,
  type StorageBackend,
} from '../../lib/local/state.js';
import type { ProjectConfig } from '../../types.js';

const STORAGE_BACKENDS: StorageBackend[] = ['local', 'minio', 'rustfs'];

/** Enough for a cold pull plus first-boot migrations on a slow machine. */
const HEALTH_TIMEOUT_MS = 240_000;
const HEALTH_INTERVAL_MS = 2_000;

/** Four containers need roughly this much before Postgres starts getting OOM-killed. */
const MIN_DOCKER_MEMORY_MB = 1_500;

interface StartOptions {
  storage?: string;
  stackTag?: string;
  pull?: boolean;
  portApp?: string;
  portAuth?: string;
  portDeno?: string;
  portPostgres?: string;
  portPostgrest?: string;
}

function parsePort(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CLIError(`Invalid ${flag}: "${value}" is not a port number between 1 and 65535.`);
  }
  return n;
}

function portOverrides(opts: StartOptions): Partial<LocalPorts> {
  const out: Partial<LocalPorts> = {};
  const app = parsePort(opts.portApp, '--port-app');
  const auth = parsePort(opts.portAuth, '--port-auth');
  const deno = parsePort(opts.portDeno, '--port-deno');
  const postgres = parsePort(opts.portPostgres, '--port-postgres');
  const postgrest = parsePort(opts.portPostgrest, '--port-postgrest');
  if (app !== undefined) out.app = app;
  if (auth !== undefined) out.auth = auth;
  if (deno !== undefined) out.deno = deno;
  if (postgres !== undefined) out.postgres = postgres;
  if (postgrest !== undefined) out.postgrest = postgrest;
  return out;
}

/** Map recorded image refs onto the compose file's INSFORGE_IMAGE_* overrides. */
export function buildImageEnv(images: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (images.insforge) env.INSFORGE_IMAGE_INSFORGE = images.insforge;
  if (images.postgres) env.INSFORGE_IMAGE_POSTGRES = images.postgres;
  if (images.deno) env.INSFORGE_IMAGE_DENO = images.deno;
  return env;
}

function resolveStorage(opts: StartOptions, previous: StorageBackend | undefined): StorageBackend {
  if (opts.storage === undefined) return previous ?? 'local';
  const value = opts.storage as StorageBackend;
  if (!STORAGE_BACKENDS.includes(value)) {
    throw new CLIError(
      `Invalid --storage "${opts.storage}". Valid: ${STORAGE_BACKENDS.join(', ')}.`,
    );
  }
  return value;
}

/**
 * Move an existing cloud link aside instead of clobbering it. Mirrors what
 * `branch switch` does with project.parent.json, so `local stop` can put the
 * cloud project back.
 */
function backupCloudLink(): string | null {
  const existing = getProjectConfig();
  if (!existing || existing.project_id === FAKE_PROJECT_ID) return null;
  const target = join(process.cwd(), '.insforge', 'project.cloud.json');
  if (!existsSync(target)) {
    copyFileSync(getProjectConfigFile(), target);
  }
  return existing.project_name;
}

async function waitForHealth(baseUrl: string, onTick: (elapsedMs: number) => void): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    const probe = await probeBackendHealth(baseUrl, 5_000);
    if (probe.reachable) return;
    if (Date.now() >= deadline) {
      throw new CLIError(
        `The backend did not become healthy within ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s.\n` +
          `Inspect the containers with:\n` +
          `  docker compose -p ${composeProjectName()} logs insforge`,
      );
    }
    onTick(Date.now() - started);
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
}

export function registerLocalStartCommand(localCmd: Command): void {
  localCmd
    .command('start')
    .description('Start a local InsForge backend in Docker and link this directory')
    .option('--storage <backend>', `Object storage backend: ${STORAGE_BACKENDS.join(', ')}`)
    .option('--stack-tag <tag>', 'Pin the stack to a release tag (e.g. v2.2.9) instead of resolving the newest')
    .option('--pull', 'Re-pull images even when they are already present locally')
    .option('--port-app <n>', 'Host port for the API and dashboard (default 7130)')
    .option('--port-auth <n>', 'Host port for the auth service (default 7131)')
    .option('--port-deno <n>', 'Host port for the functions runtime (default 7133)')
    .option('--port-postgres <n>', 'Host port for Postgres (default 5432)')
    .option('--port-postgrest <n>', 'Host port for PostgREST (default 5430)')
    .action(async (opts: StartOptions, cmd: Command) => {
      const { json } = getRootOpts(cmd);
      try {
        ensureDockerReady();

        const memory = dockerMemoryMb();
        if (memory !== null && memory < MIN_DOCKER_MEMORY_MB && !json) {
          clack.log.warn(
            `Docker has ${memory} MB available. InsForge needs about ${MIN_DOCKER_MEMORY_MB} MB for four ` +
              'containers — raise it in Docker Desktop → Settings → Resources if startup fails.',
          );
        }

        const previous = readLocalState();
        const storage = resolveStorage(opts, previous?.storage);
        const ports = resolvePorts({ ...previous?.ports, ...portOverrides(opts) });
        const projectName = previous?.projectName ?? composeProjectName();
        const ctx: ComposeContext = { projectName, storage };

        // On a restart our own containers already hold these ports, which is not
        // a conflict. Only check when nothing of ours is running; if there is a
        // genuine clash after that, `docker compose up` reports it.
        const alreadyRunning = composePs(ctx).some((s) => s.state === 'running');
        if (!alreadyRunning) {
          await ensurePortsAvailable(ports);
        }

        // Secrets are generated once. Regenerating on restart would rotate the
        // API key out from under an app that already has it in .env.local.
        const secrets = readSecrets() ?? generateSecrets();

        // Resolve the stack once per directory; later starts reuse what was
        // recorded so nothing moves under the developer. --stack-tag forces it.
        let stackTag = opts.stackTag ?? previous?.stackTag ?? null;
        let images = previous?.images ?? {};
        if (opts.stackTag) {
          images = {};
        } else if (!previous) {
          const spinner = json ? null : clack.spinner();
          spinner?.start('Resolving the newest InsForge release...');
          const resolved = await resolveStack();
          if (resolved) {
            stackTag = resolved.tag;
            images = resolved.images;
            spinner?.stop(`Using InsForge ${resolved.tag} (pinned by digest)`);
          } else {
            // No tag present in all three image repos, or the registry was
            // unreachable. The compose file's own defaults are the fallback.
            spinner?.stop('Using the versions bundled with this CLI');
          }
        }

        writeEnvFile({ secrets, ports, storage, stackTag });

        const state: LocalState = {
          version: 1,
          projectName,
          stackTag,
          images,
          storage,
          ports,
          createdAt: previous?.createdAt ?? new Date().toISOString(),
        };
        writeLocalState(state);

        // Digest-pinned refs are passed as environment, which the compose file
        // reads via INSFORGE_IMAGE_*. Compose prefers the process environment
        // over --env-file, so the recorded digests win over the tag defaults.
        const imageEnv = buildImageEnv(images);

        if (opts.pull && composeRunInherit(ctx, ['pull'], imageEnv) !== 0) {
          throw new CLIError('docker compose pull failed. See the output above.');
        }
        if (!json) clack.log.step('Starting containers...');
        if (composeRunInherit(ctx, ['up', '-d'], imageEnv) !== 0) {
          throw new CLIError('docker compose up failed. See the output above.');
        }

        const baseUrl = `http://localhost:${ports.app}`;
        const spinner = json ? null : clack.spinner();
        spinner?.start('Waiting for the backend (first boot runs migrations)...');
        await waitForHealth(baseUrl, (elapsed) => {
          spinner?.message(
            `Waiting for the backend (first boot runs migrations)... ${Math.round(elapsed / 1000)}s`,
          );
        });
        spinner?.stop('Backend is healthy');

        const displacedCloudProject = backupCloudLink();
        const projectConfig: ProjectConfig = {
          project_id: FAKE_PROJECT_ID,
          project_name: 'local',
          org_id: FAKE_ORG_ID,
          appkey: 'local',
          region: 'local',
          api_key: secrets.apiKey,
          oss_host: baseUrl,
        };
        saveProjectConfig(projectConfig);

        // NEXT_PUBLIC_* matches what `insforge create` seeds; VITE_* is added
        // because a Vite app cannot read NEXT_PUBLIC_ variables and local
        // development is overwhelmingly Vite. upsertEnvFile never overwrites an
        // existing value, so a user's own pins survive.
        const envResult = upsertEnvFile(join(process.cwd(), '.env.local'), {
          NEXT_PUBLIC_INSFORGE_URL: baseUrl,
          NEXT_PUBLIC_INSFORGE_ANON_KEY: secrets.anonKey,
          VITE_INSFORGE_URL: baseUrl,
          VITE_INSFORGE_ANON_KEY: secrets.anonKey,
        });

        await trackCommandUsage('local', 'start', true, { storage, stack_tag: stackTag ?? 'default' });

        if (json) {
          outputJson({
            success: true,
            apiUrl: baseUrl,
            dashboardUrl: baseUrl,
            databaseUrl: `postgresql://postgres:postgres@localhost:${ports.postgres}/insforge`,
            apiKey: secrets.apiKey,
            anonKey: secrets.anonKey,
            admin: { username: secrets.adminUsername, password: secrets.adminPassword },
            ports,
            storage,
            stackTag,
            images,
            composeProject: projectName,
            envLocal: envResult,
          });
          return;
        }

        clack.note(
          [
            `${pc.dim('API URL     ')} ${pc.cyan(baseUrl)}`,
            `${pc.dim('Dashboard   ')} ${pc.cyan(baseUrl)}`,
            `${pc.dim('DB URL      ')} postgresql://postgres:postgres@localhost:${ports.postgres}/insforge`,
            `${pc.dim('API key     ')} ${secrets.apiKey} ${pc.dim('(superadmin — server-side only)')}`,
            `${pc.dim('anon key    ')} ${secrets.anonKey} ${pc.dim('(safe for browsers)')}`,
            `${pc.dim('Admin login ')} ${secrets.adminUsername} / ${secrets.adminPassword}`,
            `${pc.dim('Storage     ')} ${storage === 'local' ? 'local filesystem' : `${storage} (S3 gateway enabled)`}`,
            `${pc.dim('Version     ')} ${stackTag ?? 'compose defaults'}`,
          ].join('\n'),
          'Local InsForge is running',
        );

        if (displacedCloudProject) {
          clack.log.warn(
            `This directory was linked to cloud project "${displacedCloudProject}". ` +
              'Saved to .insforge/project.cloud.json — `insforge local stop --unlink` restores it.',
          );
        }
        if (envResult.mismatched.length > 0) {
          clack.log.warn(
            `.env.local already sets ${envResult.mismatched.map((m) => m.key).join(', ')} to different ` +
              'values — left untouched. Update them by hand to point at the local backend.',
          );
        }

        clack.log.info(
          `Linked this directory. Every other command now targets the local backend:\n` +
            `  insforge db query "select 1"     insforge functions deploy\n` +
            `  insforge local status            insforge local stop`,
        );
      } catch (err) {
        await trackCommandUsage('local', 'start', false, {}, err);
        handleError(err, json);
      }
    });
}

/** Exported for tests. */
export const __testing = { parsePort, portOverrides, resolveStorage };
