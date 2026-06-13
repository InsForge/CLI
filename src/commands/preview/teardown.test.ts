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

    expect(deleteBranchApi).toHaveBeenCalledWith('branch-123', undefined, { ignoreNotFound: true });
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

  it('deletes an env file that --wire-env created (no backup to restore)', async () => {
    const envName = '.env.local';
    const envPath = path.join(tmpBase, envName);
    // The file exists (preview created it) but there is no .preview-bak.
    await fs.writeFile(envPath, 'NEXT_PUBLIC_INSFORGE_URL=https://p1ky-x9p.us-east.insforge.app\n');
    await writePreviewManifest(tmpBase, {
      name: 'feat-created',
      branchId: 'branch-789',
      appkey: 'p1ky-x9p',
      createdAt: '2026-06-10T00:00:00.000Z',
      wiredEnvFile: envName,
      wiredEnvCreated: true,
    });

    const program = new Command();
    program.exitOverride();
    const preview = program.command('preview');
    registerPreviewTeardownCommand(preview);
    await program.parseAsync(['preview', 'teardown', 'feat-created'], { from: 'user' });

    // The created env file is removed, not left pointing at the deleted branch.
    await expect(fs.access(envPath)).rejects.toThrow();
    expect(await readPreviewManifest(tmpBase, 'feat-created')).toBeNull();
  });

  it('keeps --json stdout clean of env-restore chatter', async () => {
    const envName = '.env.local';
    const envPath = path.join(tmpBase, envName);
    await fs.writeFile(envPath, 'NEXT_PUBLIC_INSFORGE_URL=https://branch.app\n');
    await fs.writeFile(envPath + '.preview-bak', 'NEXT_PUBLIC_INSFORGE_URL=https://prod.app\n');
    await writePreviewManifest(tmpBase, {
      name: 'feat-json',
      branchId: 'branch-json',
      appkey: 'p1ky-x9p',
      createdAt: '2026-06-10T00:00:00.000Z',
      wiredEnvFile: envName,
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });

    const program = new Command();
    program.exitOverride();
    program.option('--json');
    const preview = program.command('preview');
    registerPreviewTeardownCommand(preview);
    await program.parseAsync(['--json', 'preview', 'teardown', 'feat-json'], { from: 'user' });

    logSpy.mockRestore();
    // Every line written to stdout must be valid JSON — no "Restored ..." chatter.
    for (const line of logs) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(logs.some((l) => l.includes('"teardown"'))).toBe(true);
  });

});
