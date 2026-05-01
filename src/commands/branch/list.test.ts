import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerBranchListCommand } from './list.js';

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
    {
      id: 'b2',
      name: 'feat-y',
      branch_state: 'creating',
      organization_id: 'o1',
      parent_project_id: 'p1',
      appkey: 'k2',
      region: 'us-east',
      branch_created_at: '2026-04-30T00:00:00Z',
      branch_metadata: { mode: 'schema-only' },
    },
  ]),
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

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  registerBranchListCommand(program);
  return program;
}

async function runWithCapturedLog(program: Command, argv: string[]): Promise<string[]> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
  return logs;
}

describe('branch list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists siblings against project_id when not on a branch', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
      appkey: 'k',
      region: 'us-east',
      api_key: 'key',
      oss_host: 'k.us-east.insforge.app',
    });
    const program = makeProgram();
    await runWithCapturedLog(program, ['list', '--json']);
    const { listBranchesApi } = await import('../../lib/api/platform.js');
    expect(listBranchesApi).toHaveBeenCalledWith('p1', undefined);
  });

  it('lists siblings against branched_from.project_id when currently switched onto a branch', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
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
    await runWithCapturedLog(program, ['list', '--json']);
    const { listBranchesApi } = await import('../../lib/api/platform.js');
    expect(listBranchesApi).toHaveBeenCalledWith('p1', undefined);
  });

  it('json mode emits a single JSON document with the branches array', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = makeProgram();
    const logs = await runWithCapturedLog(program, ['list', '--json']);
    const out = logs.join('\n');
    const parsed = JSON.parse(out);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].name).toBe('feat-x');
  });

  it('table mode marks the current branch with `*`', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
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
    const logs = await runWithCapturedLog(program, ['list']);
    const out = logs.join('\n');
    // Current branch row should contain '*' alongside its name.
    const featXLine = out.split('\n').find(l => l.includes('feat-x'));
    expect(featXLine).toBeDefined();
    expect(featXLine).toContain('*');
    const featYLine = out.split('\n').find(l => l.includes('feat-y'));
    expect(featYLine).toBeDefined();
    expect(featYLine).not.toContain('*');
  });

  it('does not mark any branch when currently on the parent', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = makeProgram();
    const logs = await runWithCapturedLog(program, ['list']);
    const out = logs.join('\n');
    // Neither row should have a '*' marker because user is on the parent.
    const featXLine = out.split('\n').find(l => l.includes('feat-x'));
    expect(featXLine).toBeDefined();
    expect(featXLine).not.toContain('*');
  });

  it('prints "No branches." when the API returns an empty list', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { listBranchesApi } = await import('../../lib/api/platform.js');
    (listBranchesApi as any).mockResolvedValueOnce([]);
    const program = makeProgram();
    const logs = await runWithCapturedLog(program, ['list']);
    expect(logs.join('\n')).toContain('No branches.');
  });
});
