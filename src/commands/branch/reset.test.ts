import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerBranchResetCommand } from './reset.js';

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
