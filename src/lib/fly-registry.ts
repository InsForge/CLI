// registry.fly.io repositories live and die with the Fly app they belong to:
// deleting a compute service destroys its Fly app AND every image ever pushed
// to that app's registry. A cached `--image registry.fly.io/<app>:<tag>`
// reference therefore goes permanently stale the moment the service is
// deleted — and redeploying it makes the platform spin in MANIFEST_UNKNOWN
// retries until the request times out as a misleading COMPUTE_CLOUD_UNAVAILABLE.
// These helpers let the deploy/update commands catch that before (or explain
// it after) the round-trip.

import { CLIError } from './errors.js';

/** Extract the repository name from a registry.fly.io image URL, or null if
 *  the image lives in any other registry. Tolerates docker://, https://, a
 *  :tag suffix, and an @sha256 digest. */
export function flyRegistryRepo(imageUrl: string): string | null {
  const m = /^(?:docker:\/\/|https?:\/\/)?registry\.fly\.io\/([^:@/\s]+)/i.exec(imageUrl.trim());
  return m ? m[1] : null;
}

/** True when the image reference points at the registry of the Fly app that
 *  backs this very service (`<service-name>-<project-id>`). If that service
 *  does not exist, neither does the app — so the registry is empty and the
 *  deploy is guaranteed to fail. */
export function imageBelongsToOwnService(
  imageUrl: string,
  serviceName: string,
  projectIds: string[]
): boolean {
  const repo = flyRegistryRepo(imageUrl);
  if (!repo) return false;
  return projectIds.some((id) => repo === `${serviceName}-${id}`);
}

/** Appended to deploy/update failures that smell like a vanished registry
 *  image, so users get "re-push the image" instead of "cloud unavailable". */
export function staleFlyImageHint(serviceName?: string): string {
  return (
    `\nHint: this image lives in registry.fly.io, where images are deleted together with ` +
    `their service. If the service was deleted (or this tag came from an older build), ` +
    `the image no longer exists and every retry will fail the same way.\n` +
    `Rebuild and push a fresh image by deploying from source:\n` +
    `  npx @insforge/cli compute deploy <dir> --name ${serviceName ?? '<name>'}`
  );
}

/** Rewrap a deploy/update failure with the stale-image hint when it looks
 *  like the platform timed out resolving a registry.fly.io image — the
 *  signature of a manifest that no longer exists. Non-matching errors pass
 *  through untouched. */
export function withStaleImageHint(
  err: unknown,
  imageUrl: string,
  serviceName?: string
): unknown {
  if (!(err instanceof CLIError)) return err;
  if (!flyRegistryRepo(imageUrl)) return err;
  const timeoutish =
    err.code === 'COMPUTE_CLOUD_UNAVAILABLE' ||
    err.statusCode === 502 ||
    err.statusCode === 503 ||
    err.statusCode === 504;
  if (!timeoutish) return err;
  return new CLIError(
    err.message + staleFlyImageHint(serviceName),
    err.exitCode,
    err.code,
    err.statusCode
  );
}
