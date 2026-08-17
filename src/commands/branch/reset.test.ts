import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerBranchResetCommand } from './reset.js';
import { CLIError } from '../../lib/errors.js';

vi.mock('../../lib/api/platform.js', () => ({
  listBranchesApi: vi.fn(async () => [
    {
      id: 'b1',
      name: 'feat-x',
      branch_state: 'ready',
      organization_id: 'o1',
      parent_project_id: 'p1',
      appkey: 'k',
      region: 'us-east',
      branch_created_at: '2026',
      branch_metadata: { mode: 'full' },
    },
    {
      id: 'b2',
      name: 'feat-merged',
      branch_state: 'merged',
      organization_id: 'o1',
      parent_project_id: 'p1',
      appkey: 'k2',
      region: 'us-east',
      branch_created_at: '2026',
      branch_metadata: { mode: 'schema-only' },
    },
    {
      id: 'b3',
      name: 'feat-merging',
      branch_state: 'merging',
      organization_id: 'o1',
      parent_project_id: 'p1',
      appkey: 'k3',
      region: 'us-east',
      branch_created_at: '2026',
      branch_metadata: { mode: 'full' },
    },
  ]),
  resetBranchApi: vi.fn(async () => ({
    id: 'b1',
    name: 'feat-x',
    branch_state: 'resetting',
    organization_id: 'o1',
    parent_project_id: 'p1',
    appkey: 'k',
    region: 'us-east',
    branch_created_at: '2026',
  })),
  getBranchApi: vi.fn(async () => ({
    id: 'b1',
    name: 'feat-x',
    branch_state: 'ready',
    organization_id: 'o1',
    parent_project_id: 'p1',
    appkey: 'k',
    region: 'us-east',
    branch_created_at: '2026',
  })),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'parent',
    org_id: 'o1',
    appkey: 'k',
    region: 'us-east',
    api_key: 'key',
    oss_host: 'k.us-east.insforge.app',
  })),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  registerBranchResetCommand(program);
  return program;
}

describe('branch reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: confirms, calls reset, polls to ready, captures analytics', async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['reset', 'feat-x', '--yes', '--json'], { from: 'user' });
    } finally {
      logSpy.mockRestore();
    }
    const { resetBranchApi, getBranchApi } = await import('../../lib/api/platform.js');
    expect(resetBranchApi).toHaveBeenCalledWith('b1', undefined);
    expect(getBranchApi).toHaveBeenCalled();
    const { captureEvent } = await import('../../lib/analytics.js');
    expect(captureEvent).toHaveBeenCalledWith('p1', 'cli_branch_reset', expect.objectContaining({
      entry_state: 'ready',
      mode: 'full',
    }));
  });

  it('reset of merged branch is allowed (entry_state=merged threaded through analytics)', async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['reset', 'feat-merged', '--yes', '--json'], { from: 'user' });
    } finally {
      logSpy.mockRestore();
    }
    const { resetBranchApi } = await import('../../lib/api/platform.js');
    expect(resetBranchApi).toHaveBeenCalledWith('b2', undefined);
    const { captureEvent } = await import('../../lib/analytics.js');
    expect(captureEvent).toHaveBeenCalledWith('p1', 'cli_branch_reset', expect.objectContaining({
      entry_state: 'merged',
      mode: 'schema-only',
    }));
  });

  it('refuses to reset when branch is in busy state (e.g. merging) without hitting the API', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync(['reset', 'feat-merging', '--yes', '--json'], { from: 'user' }),
    ).rejects.toThrow();
    const { resetBranchApi } = await import('../../lib/api/platform.js');
    expect(resetBranchApi).not.toHaveBeenCalled();
  });

  it('errors clearly when the named branch does not exist', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync(['reset', 'ghost', '--yes', '--json'], { from: 'user' }),
    ).rejects.toThrow();
    const { resetBranchApi } = await import('../../lib/api/platform.js');
    expect(resetBranchApi).not.toHaveBeenCalled();
  });

  it('survives a transient 502 mid-poll instead of reporting a reset that is still running as failed', async () => {
    // Same failure the create poll had: a gateway 502 on the status read says
    // nothing about the reset job, which keeps running server-side.
    const platformModule = await import('../../lib/api/platform.js');
    const getBranchApi = platformModule.getBranchApi as ReturnType<typeof vi.fn>;
    getBranchApi.mockRejectedValueOnce(new CLIError('Request failed: 502', 1, undefined, 502));
    const program = makeProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const run = program.parseAsync(['reset', 'feat-x', '--yes', '--json'], { from: 'user' });
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
    }
    expect(getBranchApi.mock.calls.length).toBeGreaterThan(1);
  });

  it('fails loudly when the final state could never be confirmed, instead of reporting a stale one', async () => {
    // This command exits 0 on any non-ready state, so substituting the last
    // polled state after an unreadable final check would let a reset that went
    // 'deleted'/'conflicted' exit successfully.
    //
    // The successful 'resetting' reads first are what makes this a real test:
    // they populate the last-observed state, which is exactly what a stale
    // fallback would substitute. Rejecting every read from the start would
    // leave nothing to substitute and the test would pass either way.
    const platformModule = await import('../../lib/api/platform.js');
    const getBranchApi = platformModule.getBranchApi as ReturnType<typeof vi.fn>;
    const resetting = {
      id: 'b1', name: 'feat-x', branch_state: 'resetting',
      organization_id: 'o1', parent_project_id: 'p1', appkey: 'k', region: 'us-east',
      branch_created_at: '2026',
    };
    getBranchApi
      .mockResolvedValueOnce(resetting)
      .mockResolvedValueOnce(resetting)
      .mockResolvedValueOnce(resetting)
      .mockRejectedValue(new CLIError('Request failed: 502', 1, undefined, 502));
    const program = makeProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    let reads: number;
    try {
      // Attach the rejection handler BEFORE advancing timers, or the failure
      // surfaces as an unhandled rejection while the fake clock runs.
      const run = expect(
        program.parseAsync(['reset', 'feat-x', '--yes', '--json'], { from: 'user' }),
      ).rejects.toThrow();
      await vi.runAllTimersAsync();
      await run;
      reads = getBranchApi.mock.calls.length;
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
      // mockRejectedValue survives clearAllMocks — restore the shared impl or
      // every later test polls a 502 for the full budget.
      getBranchApi.mockReset();
      getBranchApi.mockResolvedValue({
        id: 'b1', name: 'feat-x', branch_state: 'ready',
        organization_id: 'o1', parent_project_id: 'p1', appkey: 'k', region: 'us-east',
        branch_created_at: '2026',
      });
    }
    // It kept polling for the whole budget rather than aborting on the first
    // 502, and then refused to guess the outcome from the 'resetting' state it
    // had in hand.
    expect(reads).toBeGreaterThan(10);
  });

  it('retries the verdict read so one 502 at the deadline does not lose a landed reset', async () => {
    // The final re-check decides the outcome. A branch that reached 'ready'
    // right at the deadline must not be reported as unconfirmable because a
    // single read failed.
    const platformModule = await import('../../lib/api/platform.js');
    const getBranchApi = platformModule.getBranchApi as Mock;
    const ready = {
      id: 'b1', name: 'feat-x', branch_state: 'ready',
      organization_id: 'o1', parent_project_id: 'p1', appkey: 'k', region: 'us-east',
      branch_created_at: '2026',
    };
    getBranchApi.mockImplementation(async () => {
      // Non-terminal for the whole poll window, then one 502 on the verdict
      // read, then 'ready' — the state flipped just as the budget ran out.
      const call = getBranchApi.mock.calls.length;
      if (call <= 100) return { ...ready, branch_state: 'resetting' };
      if (call === 101) throw new CLIError('Request failed: 502', 1, undefined, 502);
      return ready;
    });
    const program = makeProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    let printed: string;
    try {
      const run = program.parseAsync(['reset', 'feat-x', '--yes', '--json'], { from: 'user' });
      await vi.runAllTimersAsync();
      await run;
      printed = logSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n');
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
      getBranchApi.mockReset();
      getBranchApi.mockResolvedValue(ready);
    }
    // Resolved with the real final state rather than "could not confirm".
    expect(printed).toContain('ready');
  });

  it('gives up on a real rejection mid-poll (404 is not transient)', async () => {
    const platformModule = await import('../../lib/api/platform.js');
    const getBranchApi = platformModule.getBranchApi as ReturnType<typeof vi.fn>;
    getBranchApi.mockRejectedValueOnce(new CLIError('Branch not found', 1, undefined, 404));
    const program = makeProgram();
    await expect(
      program.parseAsync(['reset', 'feat-x', '--yes', '--json'], { from: 'user' }),
    ).rejects.toThrow();
    expect(getBranchApi).toHaveBeenCalledTimes(1);
  });

  it('throws when polling sees a terminal failure state (deleted)', async () => {
    const platformModule = await import('../../lib/api/platform.js');
    (platformModule.getBranchApi as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'b1', name: 'feat-x',
      branch_state: 'deleted',
      organization_id: 'o1', parent_project_id: 'p1', appkey: 'k', region: 'us-east',
      branch_created_at: '2026',
    });
    const program = makeProgram();
    await expect(
      program.parseAsync(['reset', 'feat-x', '--yes', '--json'], { from: 'user' }),
    ).rejects.toThrow();
  });
});
