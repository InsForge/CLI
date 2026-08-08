import { describe, expect, it } from 'vitest';
import { CLIError } from './errors.js';
import {
  flyRegistryRepo,
  imageBelongsToOwnService,
  staleFlyImageHint,
  withStaleImageHint,
} from './fly-registry.js';

const PROJECT_ID = '6cdb996f-c696-429b-b9a9-d5abd114dce5';
const OWN_IMAGE = `registry.fly.io/hospet-api-${PROJECT_ID}:cli-1783654786759`;

describe('flyRegistryRepo', () => {
  it('extracts the repo from a plain registry.fly.io ref', () => {
    expect(flyRegistryRepo(OWN_IMAGE)).toBe(`hospet-api-${PROJECT_ID}`);
  });

  it('tolerates docker:// and https:// prefixes and digests', () => {
    expect(flyRegistryRepo(`docker://registry.fly.io/foo:latest`)).toBe('foo');
    expect(flyRegistryRepo(`https://registry.fly.io/foo@sha256:abc`)).toBe('foo');
  });

  it('returns null for other registries', () => {
    expect(flyRegistryRepo('redis:7-alpine')).toBeNull();
    expect(flyRegistryRepo('ghcr.io/acme/api:v1')).toBeNull();
    expect(flyRegistryRepo('docker.io/library/nginx')).toBeNull();
    // registry.fly.io as a path segment, not the host
    expect(flyRegistryRepo('example.com/registry.fly.io/foo')).toBeNull();
  });
});

describe('imageBelongsToOwnService', () => {
  it('matches only the exact <name>-<projectId> repo', () => {
    expect(imageBelongsToOwnService(OWN_IMAGE, 'hospet-api', [PROJECT_ID])).toBe(true);
    // another service's repo that shares a name prefix must NOT match
    expect(
      imageBelongsToOwnService(
        `registry.fly.io/hospet-api-gateway-${PROJECT_ID}:v1`,
        'hospet-api',
        [PROJECT_ID]
      )
    ).toBe(false);
    // same name, different project — could be a live app elsewhere
    expect(
      imageBelongsToOwnService(OWN_IMAGE, 'hospet-api', ['00000000-0000-0000-0000-000000000000'])
    ).toBe(false);
    expect(imageBelongsToOwnService('redis:7-alpine', 'hospet-api', [PROJECT_ID])).toBe(false);
  });
});

describe('withStaleImageHint', () => {
  const timeoutErr = () =>
    new CLIError('OSS request failed: 504', 1, undefined, 504);

  it('appends the hint for timeout-ish failures on fly registry images', () => {
    const wrapped = withStaleImageHint(timeoutErr(), OWN_IMAGE, 'hospet-api') as CLIError;
    expect(wrapped.message).toContain('deleted together with');
    expect(wrapped.message).toContain('--name hospet-api');
    expect(wrapped.statusCode).toBe(504);
  });

  it('matches COMPUTE_CLOUD_UNAVAILABLE by code and 502/503 by status', () => {
    for (const err of [
      new CLIError('unavailable', 1, 'COMPUTE_CLOUD_UNAVAILABLE', 503),
      new CLIError('bad gateway', 1, undefined, 502),
      new CLIError('unavailable', 1, undefined, 503),
    ]) {
      const wrapped = withStaleImageHint(err, OWN_IMAGE, 'x') as CLIError;
      expect(wrapped.message).toContain('Hint:');
    }
  });

  it('passes through non-timeout errors, non-fly images, and non-CLIErrors', () => {
    const quota = new CLIError('quota exceeded', 1, 'COMPUTE_QUOTA_EXCEEDED', 403);
    expect(withStaleImageHint(quota, OWN_IMAGE, 'x')).toBe(quota);

    const dockerhubTimeout = timeoutErr();
    expect(withStaleImageHint(dockerhubTimeout, 'redis:7', 'x')).toBe(dockerhubTimeout);

    const plain = new Error('boom');
    expect(withStaleImageHint(plain, OWN_IMAGE, 'x')).toBe(plain);
  });

  it('falls back to a <name> placeholder when the service name is unknown', () => {
    expect(staleFlyImageHint()).toContain('--name <name>');
  });
});
