import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as ErrorsModule from '../../lib/errors.js';

const ossFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/oss.js', () => ({ ossFetch: ossFetchMock }));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/skills.js', () => ({ reportCliUsage: vi.fn() }));
vi.mock('../../lib/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: (err: unknown) => { throw err; },
  };
});

import { Command } from 'commander';
import { registerComputeDeployCommand } from './deploy.js';

/**
 * Route the mock by URL rather than by call order.
 *
 * `compute deploy` now asks /api/metadata what the provider can do before shaping
 * the request, so an assertion keyed on `mock.calls[1]` breaks as soon as another
 * call is added. Routing by URL survives that.
 */
function routeOssFetch(capabilities?: Record<string, unknown>) {
  const caps =
    capabilities ?? {
      scaleToZero: true,
      regions: true,
      ingressModes: ['host'],
      sourceBuild: 'flyctl',
      deployTokenIssuance: true,
    };
  ossFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/api/metadata') {
      return Promise.resolve({
        json: async () => ({ compute: { defaultProvider: 'test', providers: { test: caps } } }),
      });
    }
    if (url === '/api/compute/services' && !init?.method) {
      return Promise.resolve({ json: async () => [] });
    }
    return Promise.resolve({
      json: async () => ({
        id: 'svc-1',
        name: 'cache',
        status: 'started',
        endpointUrl: 'https://cache.fly.dev',
        port: 6379,
        service: { name: 'cache', status: 'running' },
        imageTag: 'insforge-x/cache:abc',
        logs: ['Step 1/2 : FROM alpine'],
      }),
    });
  });
}

/** Body of the POST that creates or prepares the service. */
function createCallBody(): Record<string, unknown> {
  const call = ossFetchMock.mock.calls.find(
    ([url, init]) =>
      typeof url === 'string' &&
      url.startsWith('/api/compute/services') &&
      (init as { method?: string } | undefined)?.method === 'POST'
  );
  if (!call) {
    throw new Error('no create/prepare POST was made');
  }
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}


describe('compute deploy --protocol', () => {
  beforeEach(() => {
    ossFetchMock.mockReset();
    routeOssFetch();
  });

  it('includes protocol="tcp" in request body when --protocol tcp', async () => {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'redis:7-alpine',
      '--name', 'cache',
      '--protocol', 'tcp',
      '--port', '6379',
    ]);
    const body = createCallBody();
    expect(body.protocol).toBe('tcp');
    expect(body.port).toBe(6379);
  });

  it('omits protocol from body when default (http) — back-compat', async () => {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'nginx', '--name', 'web', '--port', '8080',
    ]);
    const body = createCallBody();
    expect('protocol' in body).toBe(false);
  });

  it('rejects unknown --protocol', async () => {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    await expect(
      cmd.parseAsync([
        'node', 'lim', 'compute', 'deploy',
        '--image', 'redis', '--name', 'x', '--protocol', 'sctp',
      ])
    ).rejects.toThrow(/Invalid --protocol/);
  });
});

describe('compute deploy --always-on / --scale-to-zero', () => {
  beforeEach(() => {
    ossFetchMock.mockReset();
    routeOssFetch();
  });

  it('includes scaleToZero=false in request body when --always-on', async () => {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'nginx', '--name', 'api', '--always-on',
    ]);
    const body = createCallBody();
    expect(body.scaleToZero).toBe(false);
  });

  it('includes scaleToZero=true in request body when --scale-to-zero (explicit revert)', async () => {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'nginx', '--name', 'api', '--scale-to-zero',
    ]);
    const body = createCallBody();
    expect(body.scaleToZero).toBe(true);
  });

  it('omits scaleToZero from body when neither flag is passed — create defaults server-side, update keeps the existing setting', async () => {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'nginx', '--name', 'api',
    ]);
    const body = createCallBody();
    expect('scaleToZero' in body).toBe(false);
  });

  it('rejects --always-on combined with --scale-to-zero', async () => {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    await expect(
      cmd.parseAsync([
        'node', 'lim', 'compute', 'deploy',
        '--image', 'nginx', '--name', 'api', '--always-on', '--scale-to-zero',
      ])
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe('compute deploy against a single-host provider', () => {
  const DOCKER = {
    scaleToZero: false,
    regions: false,
    ingressModes: ['none', 'port', 'host'],
    sourceBuild: 'context-upload',
    deployTokenIssuance: false,
  };

  beforeEach(() => {
    ossFetchMock.mockReset();
  });

  // Sending a region to a provider with one host records a choice that never takes
  // effect, and nothing on screen says so.
  it('omits region when the provider has none', async () => {
    routeOssFetch(DOCKER);
    const cmd = new Command();
    cmd.exitOverride();
    registerComputeDeployCommand(cmd.command('compute'));
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'nginx:alpine', '--name', 'web', '--port', '8080',
    ]);
    expect(createCallBody()).not.toHaveProperty('region');
  });

  it('omits scaleToZero when the provider cannot honour it', async () => {
    routeOssFetch(DOCKER);
    const cmd = new Command();
    cmd.exitOverride();
    registerComputeDeployCommand(cmd.command('compute'));
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'nginx:alpine', '--name', 'web', '--port', '8080', '--always-on',
    ]);
    expect(createCallBody()).not.toHaveProperty('scaleToZero');
  });

  // The gate must not be a blanket removal — a provider with regions still gets one.
  it('still sends region to a provider that has regions', async () => {
    routeOssFetch();
    const cmd = new Command();
    cmd.exitOverride();
    registerComputeDeployCommand(cmd.command('compute'));
    await cmd.parseAsync([
      'node', 'lim', 'compute', 'deploy',
      '--image', 'nginx:alpine', '--name', 'web', '--port', '8080', '--region', 'lhr',
    ]);
    expect(createCallBody().region).toBe('lhr');
  });

  it('refuses source mode when the provider cannot build at all', async () => {
    routeOssFetch({ ...DOCKER, sourceBuild: 'none' });
    const cmd = new Command();
    cmd.exitOverride();
    registerComputeDeployCommand(cmd.command('compute'));
    await expect(
      cmd.parseAsync(['node', 'lim', 'compute', 'deploy', '.', '--name', 'web'])
    ).rejects.toThrow(/cannot build from source/);
  });
});
