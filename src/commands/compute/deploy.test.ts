import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as ErrorsModule from '../../lib/errors.js';
import type * as ConfigModule from '../../lib/config.js';

const PROJECT_ID = '6cdb996f-c696-429b-b9a9-d5abd114dce5';

const ossFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/oss.js', () => ({ ossFetch: ossFetchMock }));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/skills.js', () => ({ reportCliUsage: vi.fn() }));
vi.mock('../../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    getProjectConfig: () => ({ project_id: '6cdb996f-c696-429b-b9a9-d5abd114dce5' }),
  };
});
vi.mock('../../lib/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: (err: unknown) => { throw err; },
  };
});

import { Command } from 'commander';
import { registerComputeDeployCommand } from './deploy.js';

describe('compute deploy --protocol', () => {
  beforeEach(() => {
    ossFetchMock.mockReset();
    ossFetchMock.mockResolvedValueOnce({ json: async () => [] }); // initial list
    ossFetchMock.mockResolvedValueOnce({
      json: async () => ({ name: 'cache', status: 'started', endpointUrl: 'https://cache.fly.dev', port: 6379 }),
    });
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
    const createCall = ossFetchMock.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
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
    const createCall = ossFetchMock.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
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
    ossFetchMock.mockResolvedValueOnce({ json: async () => [] }); // initial list
    ossFetchMock.mockResolvedValueOnce({
      json: async () => ({ name: 'api', status: 'running', endpointUrl: 'https://api.fly.dev', port: 8080, scaleToZero: false }),
    });
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
    const createCall = ossFetchMock.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
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
    const createCall = ossFetchMock.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
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
    const createCall = ossFetchMock.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
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

describe('compute deploy stale fly-registry image guard', () => {
  const OWN_IMAGE = `registry.fly.io/hospet-api-${PROJECT_ID}:cli-1783654786759`;

  function makeCmd() {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeDeployCommand(compute);
    return cmd;
  }

  beforeEach(() => {
    ossFetchMock.mockReset();
  });

  it('fails fast (before any create call) when a fresh create references its own service registry', async () => {
    ossFetchMock.mockResolvedValueOnce({ json: async () => [] }); // list: no existing service
    await expect(
      makeCmd().parseAsync([
        'node', 'lim', 'compute', 'deploy',
        '--image', OWN_IMAGE, '--name', 'hospet-api',
      ])
    ).rejects.toThrow(/deleting a service deletes its registry images/);
    // Only the list call went out — no POST that would hang for 60s server-side.
    expect(ossFetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not block fresh creates on foreign registry.fly.io images or other registries', async () => {
    for (const image of [`registry.fly.io/other-svc-${PROJECT_ID}:v1`, 'redis:7-alpine']) {
      ossFetchMock.mockReset();
      ossFetchMock.mockResolvedValueOnce({ json: async () => [] });
      ossFetchMock.mockResolvedValueOnce({
        json: async () => ({ name: 'hospet-api', status: 'creating' }),
      });
      await makeCmd().parseAsync([
        'node', 'lim', 'compute', 'deploy',
        '--image', image, '--name', 'hospet-api',
      ]);
      expect(ossFetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('appends the stale-image hint when an update of an existing service times out', async () => {
    const { CLIError } = await vi.importActual<typeof ErrorsModule>('../../lib/errors.js');
    ossFetchMock.mockResolvedValueOnce({
      json: async () => [{ id: 'svc-1', name: 'hospet-api' }],
    });
    ossFetchMock.mockRejectedValueOnce(
      new CLIError(
        'COMPUTE_CLOUD_UNAVAILABLE: The operation was aborted due to timeout',
        1,
        'COMPUTE_CLOUD_UNAVAILABLE',
        503
      )
    );
    await expect(
      makeCmd().parseAsync([
        'node', 'lim', 'compute', 'deploy',
        '--image', OWN_IMAGE, '--name', 'hospet-api',
      ])
    ).rejects.toThrow(/Rebuild and push a fresh image by deploying from source/);
  });

  it('leaves timeout errors on non-fly images untouched', async () => {
    const { CLIError } = await vi.importActual<typeof ErrorsModule>('../../lib/errors.js');
    ossFetchMock.mockResolvedValueOnce({ json: async () => [] });
    ossFetchMock.mockRejectedValueOnce(new CLIError('OSS request failed: 504', 1, undefined, 504));
    let caught: unknown;
    try {
      await makeCmd().parseAsync([
        'node', 'lim', 'compute', 'deploy',
        '--image', 'redis:7-alpine', '--name', 'cache',
      ]);
    } catch (err) {
      caught = err;
    }
    expect(String((caught as Error).message)).not.toContain('Hint:');
  });
});
