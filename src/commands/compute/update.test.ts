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
import { registerComputeUpdateCommand } from './update.js';

describe('compute update stale fly-registry image hint', () => {
  const FLY_IMAGE = 'registry.fly.io/hospet-api-6cdb996f-c696-429b-b9a9-d5abd114dce5:cli-1783654786759';

  function makeCmd() {
    const cmd = new Command();
    cmd.exitOverride();
    const compute = cmd.command('compute');
    registerComputeUpdateCommand(compute);
    return cmd;
  }

  async function timeoutError() {
    const { CLIError } = await vi.importActual<typeof ErrorsModule>('../../lib/errors.js');
    return new CLIError(
      'COMPUTE_CLOUD_UNAVAILABLE: The operation was aborted due to timeout',
      1,
      'COMPUTE_CLOUD_UNAVAILABLE',
      503
    );
  }

  beforeEach(() => {
    ossFetchMock.mockReset();
  });

  it('appends the hint when a PATCH with --image on a fly registry ref times out', async () => {
    ossFetchMock.mockRejectedValueOnce(await timeoutError());
    await expect(
      makeCmd().parseAsync([
        'node', 'lim', 'compute', 'update', 'svc-1', '--image', FLY_IMAGE,
      ])
    ).rejects.toThrow(/Rebuild and push a fresh image by deploying from source/);
  });

  it('leaves timeouts unhinted when no --image was supplied (stored-image gap)', async () => {
    ossFetchMock.mockRejectedValueOnce(await timeoutError());
    let caught: unknown;
    try {
      await makeCmd().parseAsync([
        'node', 'lim', 'compute', 'update', 'svc-1', '--memory', '1024',
      ]);
    } catch (err) {
      caught = err;
    }
    expect(String((caught as Error).message)).not.toContain('Hint:');
  });

  it('leaves timeouts unhinted for non-fly images', async () => {
    ossFetchMock.mockRejectedValueOnce(await timeoutError());
    let caught: unknown;
    try {
      await makeCmd().parseAsync([
        'node', 'lim', 'compute', 'update', 'svc-1', '--image', 'redis:7-alpine',
      ]);
    } catch (err) {
      caught = err;
    }
    expect(String((caught as Error).message)).not.toContain('Hint:');
  });
});
