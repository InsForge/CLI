// flyctl helpers for compute v3.2 source-deploy. Path A — refined:
// the CLI shells out to `flyctl deploy --remote-only --build-only` using a
// per-app deploy token minted by the cloud. Build runs on Fly's remote
// builder; the resulting image is pushed straight to registry.fly.io. No
// local Docker daemon required — the user only needs the single flyctl
// binary on their PATH.
//
// Token shape: short-lived (~20 min) macaroon attenuated to one app +
// builder/wg features, with `else: deny`. It can deploy to that one app and
// nothing else, even within the InsForge Fly org.

import { spawnSync } from 'node:child_process';
import { CLIError } from './errors.js';

export function ensureFlyctlAvailable(): void {
  const r = spawnSync('flyctl', ['version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error || r.status !== 0) {
    throw new CLIError(
      'flyctl is required for source-mode deploy.\n' +
        '  • Install: curl -L https://fly.io/install.sh | sh\n' +
        '  • Or use --image <pre-built-image> instead.\n' +
        (r.stderr ? `  Detail: ${r.stderr.trim().slice(0, 200)}` : '')
    );
  }
}

export interface FlyctlBuildPushOptions {
  dir: string;
  appId: string; // Fly app name, e.g. "my-svc-<projectId>"
  imageLabel: string; // tag suffix; final ref will be registry.fly.io/<appId>:<imageLabel>
  token: string; // attenuated FlyV1 deploy token from cloud /deploy-token
}

/**
 * Run `flyctl deploy --remote-only --build-only` against the user's source
 * directory. Builds on Fly's remote builder, pushes to registry.fly.io, and
 * returns the resulting image ref. Does NOT launch a machine — the cloud
 * backend handles that step (it owns DB state and quota enforcement).
 *
 * The user's directory only needs a Dockerfile. If a fly.toml exists we
 * append `app = "<appId>"` via env var so it doesn't conflict with whatever
 * the user wrote there. If no fly.toml exists, flyctl invents one.
 */
export function flyctlBuildAndPush(
  opts: FlyctlBuildPushOptions
): { imageRef: string } {
  const imageRef = `registry.fly.io/${opts.appId}:${opts.imageLabel}`;
  const r = spawnSync(
    'flyctl',
    [
      'deploy',
      '--remote-only',
      '--build-only',
      '--app',
      opts.appId,
      '--image-label',
      opts.imageLabel,
      '--no-cache',
    ],
    {
      cwd: opts.dir,
      env: { ...process.env, FLY_API_TOKEN: opts.token },
      stdio: 'inherit',
    }
  );
  if (r.error) {
    throw new CLIError(`flyctl deploy could not start: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new CLIError(
      `flyctl deploy --build-only failed (exit ${r.status}). See output above.`
    );
  }
  return { imageRef };
}
