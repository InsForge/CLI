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
