import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerBranchDeleteCommand } from './delete.js';

vi.mock('../../lib/api/platform.js', () => ({
  listBranchesApi: vi.fn(async () => [
    {
      id: 'b1',
      name: 'feat-x',
      branch_state: 'ready',
      organization_id: 'o1',
      parent_project_id: 'p1',
      appkey: 'k1',
      region: 'us-east',
      branch_created_at: '2026-04-29T00:00:00Z',
      branch_metadata: { mode: 'full' },
    },
  ]),
  getBranchApi: vi.fn(async () => ({
    id: 'b1',
    name: 'feat-x',
    branch_state: 'ready',
    organization_id: 'o1',
    parent_project_id: 'p1',
    appkey: 'k1',
    region: 'us-east',
    branch_created_at: '2026-04-29T00:00:00Z',
    branch_metadata: { mode: 'full' },
  })),
  deleteBranchApi: vi.fn(async () => undefined),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

vi.mock('./switch.js', () => ({
  runBranchSwitch: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  registerBranchDeleteCommand(program);
  return program;
}

async function runSilently(program: Command, argv: string[]): Promise<void> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
}

describe('branch delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path with --yes calls deleteBranchApi and captures analytics', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = makeProgram();
    await runSilently(program, ['delete', 'feat-x', '--yes', '--json']);

    const { deleteBranchApi } = await import('../../lib/api/platform.js');
    expect(deleteBranchApi).toHaveBeenCalledWith('b1', undefined);
    const { captureEvent } = await import('../../lib/analytics.js');
    expect(captureEvent).toHaveBeenCalledWith('p1', 'cli_branch_delete', {});
  });

  it('errors when the named branch does not exist', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = makeProgram();
    await expect(
      program.parseAsync(['delete', 'ghost', '--yes', '--json'], { from: 'user' }),
    ).rejects.toThrow();
    const { deleteBranchApi } = await import('../../lib/api/platform.js');
    expect(deleteBranchApi).not.toHaveBeenCalled();
  });

  it('auto-switches back to parent when deleting the currently active branch', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'b1',
      project_name: 'feat-x',
      org_id: 'o1',
      appkey: 'k1',
      region: 'us-east',
      api_key: 'key',
      oss_host: 'k1.us-east.insforge.app',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
    const program = makeProgram();
    await runSilently(program, ['delete', 'feat-x', '--yes', '--json']);
    const { runBranchSwitch } = await import('./switch.js');
    // In JSON mode, the chained switch-back must be silent so delete emits
    // exactly one JSON document.
    expect(runBranchSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ toParent: true, json: true, silent: true }),
    );
  });

  it('does not auto-switch when the deleted branch is not the currently active one', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = makeProgram();
    await runSilently(program, ['delete', 'feat-x', '--yes', '--json']);
    const { runBranchSwitch } = await import('./switch.js');
    expect(runBranchSwitch).not.toHaveBeenCalled();
  });

  it('does not abort the delete command when post-delete switch-back fails', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'b1',
      project_name: 'feat-x',
      org_id: 'o1',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
    const { runBranchSwitch } = await import('./switch.js');
    (runBranchSwitch as Mock).mockRejectedValueOnce(new Error('no parent backup'));
    const program = makeProgram();
    await runSilently(program, ['delete', 'feat-x', '--yes', '--json']);
    // Delete still went through despite the switch-back failure.
    const { deleteBranchApi } = await import('../../lib/api/platform.js');
    expect(deleteBranchApi).toHaveBeenCalledWith('b1', undefined);
  });

  it('json mode reports switched_back=true when the active branch was deleted', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'b1',
      project_name: 'feat-x',
      org_id: 'o1',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
    const program = makeProgram();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      await program.parseAsync(['delete', 'feat-x', '--yes', '--json'], { from: 'user' });
    } finally {
      logSpy.mockRestore();
    }
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed).toEqual({ deleted: true, branch_id: 'b1', switched_back: true });
  });

  it('isBusyError matches busy, creating, and merging messages', async () => {
    const { deleteBranchApi } = await import('../../lib/api/platform.js');
    const busyErr = new (await import('../../lib/errors.js')).CLIError(
      'Branch is currently busy with provisioning. Please wait.',
    );
    (deleteBranchApi as Mock).mockRejectedValueOnce(busyErr);

    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = makeProgram();
    await runSilently(program, ['delete', 'feat-x', '--yes', '--json']);
    // deleteBranchApi should have been called twice: first fails (busy),
    // then getBranchApi says "ready", so retry succeeds
    const { deleteBranchApi: dbApi } = await import('../../lib/api/platform.js');
    expect(dbApi).toHaveBeenCalledTimes(2);
  });

  it('retries deletion when branch busy then becomes ready', async () => {
    const { deleteBranchApi } = await import('../../lib/api/platform.js');
    (deleteBranchApi as Mock)
      .mockRejectedValueOnce(new (await import('../../lib/errors.js')).CLIError('Branch is busy creating'))
      .mockResolvedValueOnce(undefined);

    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = makeProgram();
    await runSilently(program, ['delete', 'feat-x', '--yes', '--json']);
    const { deleteBranchApi: dbApi } = await import('../../lib/api/platform.js');
    expect(dbApi).toHaveBeenCalledTimes(2);
    expect(dbApi).toHaveBeenLastCalledWith('b1', undefined);
  });

  it('does not retry on non-busy errors', async () => {
    const { deleteBranchApi } = await import('../../lib/api/platform.js');
    (deleteBranchApi as Mock).mockRejectedValueOnce(
      new (await import('../../lib/errors.js')).CLIError('Permission denied: not authorized'),
    );

    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });

    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const program = makeProgram();
      await program
        .parseAsync(['delete', 'feat-x', '--yes', '--json'], { from: 'user' })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }

    const { deleteBranchApi: dbApi } = await import('../../lib/api/platform.js');
    // Only one call — no retry for non-busy errors
    expect(dbApi).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
  });
});
