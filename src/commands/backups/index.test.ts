import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerBackupsCommands } from './index.js';

const FAKE_PROJECT_ID = 'fa4e0000-1234-5678-90ab-cd1234567890';

const ossBackup = {
  id: 'oss-b1',
  name: 'nightly',
  triggerSource: 'manual' as const,
  status: 'completed' as const,
  sizeBytes: 2048,
  errorMessage: null,
  createdAt: '2026-08-01T00:00:00Z',
  completedAt: '2026-08-01T00:01:00Z',
  createdBy: null,
  expiresAt: null,
};

vi.mock('../../lib/api/platform.js', () => ({
  listBackups: vi.fn(async () => []),
  getLatestBackup: vi.fn(async () => null),
  createBackup: vi.fn(async () => ({ message: 'Backup started', project: { id: 'p1', name: 'x', status: 'active' } })),
  renameBackup: vi.fn(async () => ({ id: 'b1', name: 'new' })),
  deleteBackup: vi.fn(async () => {}),
  restoreBackup: vi.fn(async () => {}),
}));

vi.mock('../../lib/api/oss.js', () => ({
  listOssBackups: vi.fn(async () => [ossBackup]),
  createOssBackup: vi.fn(async () => ({ ...ossBackup, id: 'oss-b2', status: 'running', sizeBytes: null, completedAt: null })),
  renameOssBackup: vi.fn(async () => ({ ...ossBackup, name: 'renamed' })),
  deleteOssBackup: vi.fn(async () => {}),
  restoreOssBackup: vi.fn(async () => {}),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok' })),
}));

vi.mock('../../lib/config.js', () => ({
  FAKE_PROJECT_ID: 'fa4e0000-1234-5678-90ab-cd1234567890',
  getProjectId: vi.fn(),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  const backupsCmd = program.command('backups');
  registerBackupsCommands(backupsCmd);
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

async function setProjectId(id: string) {
  const { getProjectId } = await import('../../lib/config.js');
  (getProjectId as Mock).mockImplementation((override?: string) => override ?? id);
}

describe('backups — OSS (self-hosted) mode', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setProjectId(FAKE_PROJECT_ID);
  });

  it('list uses the OSS route, not the Platform API', async () => {
    const { listOssBackups } = await import('../../lib/api/oss.js');
    const { listBackups } = await import('../../lib/api/platform.js');
    const logs = await runWithCapturedLog(makeProgram(), ['backups', 'list', '--json']);
    expect(listOssBackups).toHaveBeenCalled();
    expect(listBackups).not.toHaveBeenCalled();
    const data = JSON.parse(logs.join('\n')) as { id: string }[];
    expect(data[0].id).toBe('oss-b1');
  });

  it('latest derives the newest backup from the list', async () => {
    const { listOssBackups } = await import('../../lib/api/oss.js');
    (listOssBackups as Mock).mockResolvedValueOnce([
      { ...ossBackup, id: 'old', createdAt: '2026-07-01T00:00:00Z' },
      { ...ossBackup, id: 'new', createdAt: '2026-08-02T00:00:00Z' },
    ]);
    const logs = await runWithCapturedLog(makeProgram(), ['backups', 'latest', '--json']);
    expect((JSON.parse(logs.join('\n')) as { id: string }).id).toBe('new');
  });

  it('create --wait polls until the backup settles', async () => {
    const { listOssBackups, createOssBackup } = await import('../../lib/api/oss.js');
    (listOssBackups as Mock).mockResolvedValueOnce([{ ...ossBackup, id: 'oss-b2' }]);
    const logs = await runWithCapturedLog(makeProgram(), ['backups', 'create', '--wait', '--json']);
    expect(createOssBackup).toHaveBeenCalled();
    expect((JSON.parse(logs.join('\n')) as { status: string }).status).toBe('completed');
  });

  it('restore --yes hits the OSS restore route', async () => {
    const { restoreOssBackup } = await import('../../lib/api/oss.js');
    const { restoreBackup } = await import('../../lib/api/platform.js');
    const logs = await runWithCapturedLog(makeProgram(), ['backups', 'restore', 'oss-b1', '--yes', '--json']);
    expect(restoreOssBackup).toHaveBeenCalledWith('oss-b1');
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join('\n'))).toEqual({ restored: true, backup_id: 'oss-b1' });
  });

  it('delete --yes hits the OSS delete route', async () => {
    const { deleteOssBackup } = await import('../../lib/api/oss.js');
    await runWithCapturedLog(makeProgram(), ['backups', 'delete', 'oss-b1', '--yes', '--json']);
    expect(deleteOssBackup).toHaveBeenCalledWith('oss-b1');
  });

  it('rename hits the OSS rename route', async () => {
    const { renameOssBackup } = await import('../../lib/api/oss.js');
    const logs = await runWithCapturedLog(makeProgram(), ['backups', 'rename', 'oss-b1', 'renamed', '--json']);
    expect(renameOssBackup).toHaveBeenCalledWith('oss-b1', 'renamed');
    expect((JSON.parse(logs.join('\n')) as { name: string }).name).toBe('renamed');
  });
});

describe('backups — cloud mode', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setProjectId('11111111-2222-3333-4444-555555555555');
  });

  it('list keeps using the Platform API', async () => {
    const { listBackups } = await import('../../lib/api/platform.js');
    const { listOssBackups } = await import('../../lib/api/oss.js');
    await runWithCapturedLog(makeProgram(), ['backups', 'list', '--json']);
    expect(listBackups).toHaveBeenCalled();
    expect(listOssBackups).not.toHaveBeenCalled();
  });

  it('an explicit --project targets the cloud project even when linked OSS', async () => {
    await setProjectId(FAKE_PROJECT_ID);
    const { listBackups } = await import('../../lib/api/platform.js');
    await runWithCapturedLog(makeProgram(), [
      'backups', 'list', '--project', '11111111-2222-3333-4444-555555555555', '--json',
    ]);
    expect(listBackups).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555', undefined);
  });
});
