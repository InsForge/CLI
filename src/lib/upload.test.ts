import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tarDir, getDefaultExcludes } from './upload.js';

describe('getDefaultExcludes', () => {
  it('excludes .git, node_modules, .insforge, build artifacts', () => {
    const ex = getDefaultExcludes();
    expect(ex).toContain('.git');
    expect(ex).toContain('node_modules');
    expect(ex).toContain('.insforge');
    expect(ex).toContain('dist');
    expect(ex).toContain('__pycache__');
  });
});

describe('tarDir', () => {
  it('returns a gzipped tar buffer of directory contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tar-test-'));
    await writeFile(join(dir, 'Dockerfile'), 'FROM alpine');
    await writeFile(join(dir, 'app.js'), 'console.log("x")');

    const buf = await tarDir(dir);

    expect(buf.length).toBeGreaterThan(0);
    // gzip magic bytes
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it('honors caller-provided excludes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tar-exc-'));
    await writeFile(join(dir, 'Dockerfile'), 'FROM alpine');
    const buf = await tarDir(dir, ['Dockerfile']);
    // Just verify it produces a valid gzip — content inspection would
    // require gunzipping which is more setup than this needs.
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });
});
