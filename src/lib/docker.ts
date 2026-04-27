// Docker helpers for compute v3.1 source-deploy. Path A: the CLI builds
// locally and pushes to registry.fly.io using a per-app deploy token minted
// by the cloud (no FLY_API_TOKEN ever on the user's machine).

import { spawnSync } from 'node:child_process';
import { CLIError } from './errors.js';

export function ensureDockerAvailable(): void {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error || r.status !== 0) {
    throw new CLIError(
      'Docker is required for source-mode deploy.\n' +
        '  • Install Docker Desktop: https://docs.docker.com/get-docker/\n' +
        '  • Or use --image <pre-built-image> instead.\n' +
        (r.stderr ? `  Detail: ${r.stderr.trim().slice(0, 200)}` : '')
    );
  }
}

export interface BuildOptions {
  dir: string;
  imageRef: string; // e.g. registry.fly.io/<app>:<tag>
  platform?: string; // default linux/amd64 — Fly Machines only run amd64
}

export function dockerBuild({ dir, imageRef, platform = 'linux/amd64' }: BuildOptions): void {
  const r = spawnSync(
    'docker',
    ['build', '--platform', platform, '-t', imageRef, dir],
    { stdio: 'inherit' }
  );
  if (r.error) {
    throw new CLIError(`docker build could not start: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new CLIError(`docker build failed (exit ${r.status}). See output above.`);
  }
}

export function dockerLogin(registry: string, password: string): void {
  const r = spawnSync('docker', ['login', registry, '-u', 'x', '--password-stdin'], {
    input: password,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error) {
    throw new CLIError(`docker login could not start: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new CLIError(
      `docker login ${registry} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`
    );
  }
}

export function dockerPush(imageRef: string): void {
  const r = spawnSync('docker', ['push', imageRef], { stdio: 'inherit' });
  if (r.error) {
    throw new CLIError(`docker push could not start: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new CLIError(`docker push ${imageRef} failed (exit ${r.status}). See output above.`);
  }
}
