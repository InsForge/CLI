import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerPreviewCreateCommand } from './create.js';
import { readPreviewManifest } from '../../lib/preview-manifest.js';

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
});
