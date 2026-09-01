import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packBuildContext } from './build-context.js';

/** Entry names in a tar, read from the 100-byte name field of each 512-byte header. */
function tarEntryNames(tar: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length; offset += 512) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString('utf8')
      .replace(/\0+$/, '');
    if (!name) {
      continue;
    }
    names.push(name);
    const size = parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString('utf8')
        .replace(/\0+$/, '')
        .trim() || '0',
      8,
    );
    // Skip the file body, rounded up to the next 512-byte block.
    offset += Math.ceil(size / 512) * 512;
  }
  return names;
}

describe('packBuildContext', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('includes the tree by default, unlike the static-deploy bundler', async () => {
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n');
    // A Dockerfile may legitimately COPY any of these, so none may be dropped.
    await fs.mkdir(path.join(dir, 'dist'));
    await fs.writeFile(path.join(dir, 'dist', 'app.js'), 'x');
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'dep.js'), 'y');

    const { tar, fileCount } = await packBuildContext(dir);
    const names = tarEntryNames(tar);

    expect(names).toContain('Dockerfile');
    expect(names).toContain('dist/app.js');
    expect(names).toContain('node_modules/dep.js');
    expect(fileCount).toBe(3);
  });

  it('honours .dockerignore, including negations', async () => {
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n');
    await fs.writeFile(
      path.join(dir, '.dockerignore'),
      'secrets/\n*.log\n!keep.log\n',
    );
    await fs.mkdir(path.join(dir, 'secrets'));
    await fs.writeFile(path.join(dir, 'secrets', 'key.pem'), 'private');
    await fs.writeFile(path.join(dir, 'debug.log'), 'noise');
    await fs.writeFile(path.join(dir, 'keep.log'), 'wanted');

    const names = tarEntryNames((await packBuildContext(dir)).tar);

    expect(names).not.toContain('secrets/key.pem');
    expect(names).not.toContain('debug.log');
    expect(names).toContain('keep.log');
    expect(names).toContain('Dockerfile');
  });

  // Usually the largest thing in the tree, almost never needed by a build, and it
  // carries every secret ever committed.
  it('always excludes .git', async () => {
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n');
    await fs.mkdir(path.join(dir, '.git', 'objects'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'config'), '[core]');
    await fs.writeFile(path.join(dir, '.git', 'objects', 'blob'), 'data');

    const names = tarEntryNames((await packBuildContext(dir)).tar);

    expect(names.some((n) => n.startsWith('.git'))).toBe(false);
    expect(names).toContain('Dockerfile');
  });

  it('produces a tar the daemon can read (512-byte blocks, name in the header)', async () => {
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n');
    const { tar } = await packBuildContext(dir);

    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(0, 10).toString('utf8')).toContain('Dockerfile');
  });
});
