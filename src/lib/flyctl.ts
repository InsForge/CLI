// flyctl helpers for compute v3.2 source-deploy. Path A — refined:
// the CLI shells out to `flyctl deploy --remote-only --build-only --push`
// using a per-app deploy token minted by the cloud. Build runs on Fly's
// remote builder; the resulting image is pushed straight to registry.fly.io.
// No local Docker daemon required — the user only needs the single flyctl
// binary on their PATH.
//
// Token shape: short-lived (~20 min) macaroon attenuated to one app +
// builder/wg features, with `else: deny`. It can deploy to that one app and
// nothing else, even within the InsForge Fly org.

import { spawn, spawnSync } from 'node:child_process';
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
  imageLabel: string; // tag suffix; only used as buildkit's --image-label.
  token: string; // attenuated FlyV1 deploy token from cloud /deploy-token
}

/**
 * Run `flyctl deploy --remote-only --build-only --push` against the user's
 * source directory. Builds on Fly's remote builder, pushes to registry.fly.io,
 * and returns the resulting image ref. Does NOT launch a machine — the cloud
 * backend handles that step (it owns DB state and quota enforcement).
 *
 * IMPORTANT: returns the **digest-pinned** ref `<app>@sha256:<digest>`, not
 * the tag-based `<app>:<label>` ref. buildkit's `--build-only --push` lands
 * the manifest in the remote builder's namespace, and Fly's registry then
 * aliases the user-app namespace to it by content digest. The bare tag does
 * not always resolve (and racily fails on Fly's side as MANIFEST_UNKNOWN),
 * but the digest always does. The cloud's launchMachine accepts either form.
 *
 * The user's directory only needs a Dockerfile. flyctl will invent a fly.toml
 * if none exists.
 */
export function flyctlBuildAndPush(
  opts: FlyctlBuildPushOptions
): Promise<{ imageRef: string }> {
  return new Promise<{ imageRef: string }>((resolve, reject) => {
    const child = spawn(
      'flyctl',
      [
        'deploy',
        '--remote-only',
        '--build-only',
        '--push',
        '--app',
        opts.appId,
        '--image-label',
        opts.imageLabel,
        '--no-cache',
      ],
      {
        cwd: opts.dir,
        env: { ...process.env, FLY_API_TOKEN: opts.token },
        stdio: ['inherit', 'pipe', 'pipe'],
      }
    );

    // Tee child's stdout+stderr to our own (so the user sees buildkit
    // progress in real time) AND capture them so we can parse the digest.
    let captured = '';
    child.stdout?.on('data', (b) => {
      const s = b.toString();
      captured += s;
      process.stdout.write(s);
    });
    child.stderr?.on('data', (b) => {
      const s = b.toString();
      captured += s;
      process.stderr.write(s);
    });
    child.on('error', (err) => {
      reject(new CLIError(`flyctl deploy could not start: ${err.message}`));
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        return reject(
          new CLIError(`flyctl deploy --build-only failed (exit ${code}). See output above.`)
        );
      }
      // buildkit emits "pushing manifest for registry.fly.io/<app>:<label>@sha256:<digest>"
      // when the upload lands. Pin to that digest so the cloud's machine API
      // can resolve unambiguously regardless of registry tag-aliasing races.
      const m = captured.match(/pushing manifest for registry\.fly\.io\/[^\s]+@(sha256:[0-9a-f]+)/);
      if (!m) {
        return reject(
          new CLIError(
            'flyctl deploy succeeded but the buildkit "pushing manifest" line was not found. ' +
              'Cannot determine image digest — please re-run with FLY_LOG_LEVEL=debug and report.'
          )
        );
      }
      resolve({ imageRef: `registry.fly.io/${opts.appId}@${m[1]}` });
    });
  });
}
