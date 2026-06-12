import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { overwriteEnvFile } from './env-writer.js';

describe('overwriteEnvFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'env-overwrite-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("overwrites an existing key's value", async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'NEXT_PUBLIC_INSFORGE_URL=https://prod.insforge.app\n');
    const res = overwriteEnvFile(file, {
      NEXT_PUBLIC_INSFORGE_URL: 'https://branch.insforge.app',
    });
    expect(res.changed).toEqual(['NEXT_PUBLIC_INSFORGE_URL']);
    expect(res.added).toEqual([]);
    const content = await readFile(file, 'utf-8');
    expect(content).toContain('NEXT_PUBLIC_INSFORGE_URL=https://branch.insforge.app');
    expect(content).not.toContain('prod.insforge.app');
  });

  it('appends a key that is absent', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'EXISTING=1\n');
    const res = overwriteEnvFile(file, {
      NEXT_PUBLIC_INSFORGE_URL: 'https://branch.insforge.app',
    });
    expect(res.added).toEqual(['NEXT_PUBLIC_INSFORGE_URL']);
    expect(res.changed).toEqual([]);
    const content = await readFile(file, 'utf-8');
    expect(content).toContain('EXISTING=1');
    expect(content).toContain('NEXT_PUBLIC_INSFORGE_URL=https://branch.insforge.app');
  });

  it('leaves unrelated lines and comments intact', async () => {
    const file = path.join(dir, '.env');
    const original = [
      '# leading comment',
      'OTHER_KEY=keepme',
      'NEXT_PUBLIC_INSFORGE_URL=https://prod.insforge.app',
      '# trailing comment',
      '',
    ].join('\n');
    await writeFile(file, original);
    overwriteEnvFile(file, {
      NEXT_PUBLIC_INSFORGE_URL: 'https://branch.insforge.app',
    });
    const content = await readFile(file, 'utf-8');
    expect(content).toContain('# leading comment');
    expect(content).toContain('OTHER_KEY=keepme');
    expect(content).toContain('# trailing comment');
    expect(content).toContain('NEXT_PUBLIC_INSFORGE_URL=https://branch.insforge.app');
  });
});
