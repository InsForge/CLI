import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerPreviewCreateCommand } from './create.js';
import { readPreviewManifest, writePreviewManifest } from '../../lib/preview-manifest.js';
import { getBranchApi, deleteBranchApi } from '../../lib/api/platform.js';

vi.mock('../../lib/api/platform.js', () => ({
  createBranchApi: vi.fn(async (_p: string, body: { mode: string; name: string }) => ({
    id: 'branch-123',
    parent_project_id: 'p1',
    organization_id: 'o1',
    name: body.name,
    appkey: 'p1ky-x9p',
    region: 'us-east',
    branch_state: 'creating',
    branch_created_at: '2026-06-10T00:00:00.000Z',
    branch_metadata: { mode: body.mode },
  })),
  getBranchApi: vi.fn(async () => ({
    id: 'branch-123',
    parent_project_id: 'p1',
    organization_id: 'o1',
    name: 'feat-likes',
    appkey: 'p1ky-x9p',
    region: 'us-east',
    branch_state: 'ready',
    branch_created_at: '2026-06-10T00:00:00.000Z',
    branch_metadata: { mode: 'full' },
  })),
  deleteBranchApi: vi.fn(async () => {}),
}));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn(async () => ({})) }));
vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

let tmpBase: string;
vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({ project_id: 'p1', branched_from: null })),
}));

describe('preview create', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-cmd-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpBase);
  });

  it('creates a branch and writes a manifest', async () => {
    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewCreateCommand(preview);
    await program.parseAsync(['preview', 'create', 'feat-likes'], { from: 'user' });

    const manifest = await readPreviewManifest(tmpBase, 'feat-likes');
    expect(manifest).not.toBeNull();
    expect(manifest?.branchId).toBe('branch-123');
    expect(manifest?.appkey).toBe('p1ky-x9p');
  });

  it('wires the given env file at the branch backend and backs it up', async () => {
    const envFile = path.join(tmpBase, '.env.custom');
    await fs.writeFile(
      envFile,
      'NEXT_PUBLIC_INSFORGE_URL=https://prod.insforge.app\n',
    );

    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewCreateCommand(preview);
    await program.parseAsync(
      ['preview', 'create', 'feat-likes', '--wire-env', envFile],
      { from: 'user' },
    );

    const content = await fs.readFile(envFile, 'utf-8');
    expect(content).toContain(
      'NEXT_PUBLIC_INSFORGE_URL=https://p1ky-x9p.us-east.insforge.app',
    );
    expect(content).not.toContain('prod.insforge.app');

    const backup = await fs.readFile(envFile + '.preview-bak', 'utf-8');
    expect(backup).toContain('NEXT_PUBLIC_INSFORGE_URL=https://prod.insforge.app');

    const manifest = await readPreviewManifest(tmpBase, 'feat-likes');
    expect(manifest?.wiredEnvFile).toBe(envFile);
  });

  it('defaults --wire-env to .env.local and records it was created', async () => {
    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewCreateCommand(preview);
    // --wire-env with no value; .env.local does not exist in tmpBase yet.
    await program.parseAsync(['preview', 'create', 'feat-likes', '--wire-env'], { from: 'user' });

    const created = await fs.readFile(path.join(tmpBase, '.env.local'), 'utf-8');
    expect(created).toContain('NEXT_PUBLIC_INSFORGE_URL=https://p1ky-x9p.us-east.insforge.app');
    const manifest = await readPreviewManifest(tmpBase, 'feat-likes');
    expect(manifest?.wiredEnvFile).toBe('.env.local');
    expect(manifest?.wiredEnvCreated).toBe(true);
  });

  it('rolls back the branch when provisioning never reaches ready', async () => {
    vi.mocked(getBranchApi).mockResolvedValueOnce({
      id: 'branch-123',
      parent_project_id: 'p1',
      organization_id: 'o1',
      name: 'feat-likes',
      appkey: 'p1ky-x9p',
      region: 'us-east',
      branch_state: 'conflicted',
      branch_created_at: '2026-06-10T00:00:00.000Z',
      branch_metadata: { mode: 'full' },
    } as Awaited<ReturnType<typeof getBranchApi>>);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => { throw new Error('exit'); }) as never);

    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewCreateCommand(preview);
    await expect(
      program.parseAsync(['preview', 'create', 'feat-likes'], { from: 'user' }),
    ).rejects.toThrow();

    // The half-provisioned branch is cleaned up, and no manifest is left behind.
    expect(deleteBranchApi).toHaveBeenCalledWith('branch-123', undefined);
    expect(await readPreviewManifest(tmpBase, 'feat-likes')).toBeNull();
    exitSpy.mockRestore();
  });

  it('refuses to create when a preview of the same name already exists', async () => {
    await writePreviewManifest(tmpBase, {
      name: 'feat-likes',
      branchId: 'old-branch',
      appkey: 'old',
      createdAt: '2026-06-10T00:00:00.000Z',
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => { throw new Error('exit'); }) as never);

    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewCreateCommand(preview);
    await expect(
      program.parseAsync(['preview', 'create', 'feat-likes'], { from: 'user' }),
    ).rejects.toThrow();

    // The existing manifest is untouched (its branchId is not clobbered).
    const manifest = await readPreviewManifest(tmpBase, 'feat-likes');
    expect(manifest?.branchId).toBe('old-branch');
    exitSpy.mockRestore();
  });
});
