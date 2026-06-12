import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerPreviewTeardownCommand } from './teardown.js';
import { writePreviewManifest, readPreviewManifest } from '../../lib/preview-manifest.js';
import { deleteBranchApi } from '../../lib/api/platform.js';

vi.mock('../../lib/api/platform.js', () => ({ deleteBranchApi: vi.fn(async () => {}) }));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn(async () => ({})) }));
vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

let tmpBase: string;

describe('preview teardown', () => {
  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-td-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpBase);
    await writePreviewManifest(tmpBase, {
      name: 'feat-likes',
      branchId: 'branch-123',
      appkey: 'p1ky-x9p',
      createdAt: '2026-06-10T00:00:00.000Z',
    });
  });

  it('deletes the branch and removes the manifest', async () => {
    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewTeardownCommand(preview);
    await program.parseAsync(['preview', 'teardown', 'feat-likes'], { from: 'user' });

    expect(deleteBranchApi).toHaveBeenCalledWith('branch-123', undefined);
    expect(await readPreviewManifest(tmpBase, 'feat-likes')).toBeNull();
  });

  it('restores the wired env file from its backup', async () => {
    const envName = '.env.custom';
    const envPath = path.join(tmpBase, envName);
    await fs.writeFile(
      envPath,
      'NEXT_PUBLIC_INSFORGE_URL=https://p1ky-x9p.us-east.insforge.app\n',
    );
    await fs.writeFile(
      envPath + '.preview-bak',
      'NEXT_PUBLIC_INSFORGE_URL=https://prod.insforge.app\n',
    );
    await writePreviewManifest(tmpBase, {
      name: 'feat-wired',
      branchId: 'branch-456',
      appkey: 'p1ky-x9p',
      createdAt: '2026-06-10T00:00:00.000Z',
      wiredEnvFile: envName,
    });

    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewTeardownCommand(preview);
    await program.parseAsync(['preview', 'teardown', 'feat-wired'], { from: 'user' });

    const restored = await fs.readFile(envPath, 'utf-8');
    expect(restored).toContain('NEXT_PUBLIC_INSFORGE_URL=https://prod.insforge.app');
    await expect(fs.access(envPath + '.preview-bak')).rejects.toThrow();
    expect(await readPreviewManifest(tmpBase, 'feat-wired')).toBeNull();
  });
});
