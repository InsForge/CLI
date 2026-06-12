import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writePreviewManifest,
  readPreviewManifest,
  deletePreviewManifest,
  type PreviewManifest,
} from './preview-manifest.js';

describe('preview-manifest', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips a manifest by name', async () => {
    const manifest: PreviewManifest = {
      name: 'feat-likes',
      branchId: 'branch-123',
      appkey: 'p1ky-x9p',
      createdAt: '2026-06-10T00:00:00.000Z',
    };
    await writePreviewManifest(dir, manifest);
    const read = await readPreviewManifest(dir, 'feat-likes');
    expect(read).toEqual(manifest);
  });

  it('returns null for a missing manifest', async () => {
    const read = await readPreviewManifest(dir, 'nope');
    expect(read).toBeNull();
  });

  it('deletes a manifest', async () => {
    const manifest: PreviewManifest = {
      name: 'feat-likes',
      branchId: 'branch-123',
      appkey: 'p1ky-x9p',
      createdAt: '2026-06-10T00:00:00.000Z',
    };
    await writePreviewManifest(dir, manifest);
    await deletePreviewManifest(dir, 'feat-likes');
    expect(await readPreviewManifest(dir, 'feat-likes')).toBeNull();
  });
});
