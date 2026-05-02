import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBranchSwitch } from './switch.js';

const saveCalls: any[] = [];

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(),
  saveProjectConfig: vi.fn((c: any) => saveCalls.push(c)),
  getProjectConfigFile: () => '/tmp/_test_/.insforge/project.json',
  getParentBackupFile: () => '/tmp/_test_/.insforge/project.parent.json',
  FAKE_PROJECT_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/api/platform.js', () => ({
  listBranchesApi: vi.fn(async () => [
    {
      id: 'b1',
      name: 'feat-x',
      organization_id: 'o1',
      parent_project_id: 'p1',
      appkey: 'p1ky-x9p',
      region: 'us-east',
      branch_state: 'ready',
      branch_created_at: '2026-04-29',
      branch_metadata: { mode: 'full' },
    },
  ]),
  getProjectApiKey: vi.fn(async () => 'branch-api-key'),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('node:fs', () => fsMock);

describe('runBranchSwitch', () => {
  beforeEach(() => {
    saveCalls.length = 0;
    fsMock.existsSync.mockReset();
    fsMock.copyFileSync.mockReset();
    fsMock.unlinkSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
  });

  it('switches from parent to a branch and creates parent.json backup', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
      appkey: 'p1ky',
      region: 'us-east',
      api_key: 'parent-key',
      oss_host: 'p1ky.us-east.insforge.app',
    });
    fsMock.existsSync.mockReturnValueOnce(false); // parent.json backup absent
    await runBranchSwitch({ name: 'feat-x', apiUrl: undefined, json: true });
    expect(fsMock.copyFileSync).toHaveBeenCalledWith(
      '/tmp/_test_/.insforge/project.json',
      '/tmp/_test_/.insforge/project.parent.json',
    );
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toMatchObject({
      project_id: 'b1',
      project_name: 'feat-x',
      api_key: 'branch-api-key',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
  });

  it('preserves parent backup when switching branch -> branch', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'b0',
      project_name: 'feat-y',
      org_id: 'o1',
      appkey: 'p1ky-old',
      region: 'us-east',
      api_key: 'branch-y-key',
      oss_host: 'p1ky-old.us-east.insforge.app',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
    fsMock.existsSync.mockReturnValueOnce(true); // backup already exists; do not overwrite
    await runBranchSwitch({ name: 'feat-x', apiUrl: undefined, json: true });
    expect(fsMock.copyFileSync).not.toHaveBeenCalled();
    expect(saveCalls[0].branched_from).toEqual({
      project_id: 'p1',
      project_name: 'parent',
    });
  });

  it('refuses to switch to a branch not in ready state', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({ project_id: 'p1', project_name: 'parent', org_id: 'o1' });
    const { listBranchesApi } = await import('../../lib/api/platform.js');
    (listBranchesApi as any).mockResolvedValueOnce([
      {
        id: 'b1',
        name: 'feat-x',
        organization_id: 'o1',
        parent_project_id: 'p1',
        appkey: 'p1ky-x9p',
        region: 'us-east',
        branch_state: 'creating',
        branch_created_at: '2026-04-29',
        branch_metadata: { mode: 'full' },
      },
    ]);
    await expect(
      runBranchSwitch({ name: 'feat-x', apiUrl: undefined, json: true }),
    ).rejects.toThrow(/state 'creating'/);
  });

  it('--parent restores from backup and removes the backup file', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'b1',
      project_name: 'feat-x',
      org_id: 'o1',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
    fsMock.existsSync.mockReturnValueOnce(true); // backup present
    await runBranchSwitch({ toParent: true, apiUrl: undefined, json: true });
    expect(fsMock.copyFileSync).toHaveBeenCalledWith(
      '/tmp/_test_/.insforge/project.parent.json',
      '/tmp/_test_/.insforge/project.json',
    );
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(
      '/tmp/_test_/.insforge/project.parent.json',
    );
  });

  it('rejects passing both a branch name and --parent', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({
      project_id: 'b1',
      project_name: 'feat-x',
      org_id: 'o1',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
    await expect(
      runBranchSwitch({ name: 'feat-x', toParent: true, apiUrl: undefined, json: true }),
    ).rejects.toThrow(/either a branch name or --parent/);
  });

  it('--parent fails clearly when no backup exists', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue({ project_id: 'b1', project_name: 'feat-x', org_id: 'o1' });
    fsMock.existsSync.mockReturnValueOnce(false);
    await expect(
      runBranchSwitch({ toParent: true, apiUrl: undefined, json: true }),
    ).rejects.toThrow(/No parent backup/);
  });
});
