import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertEnvFile } from './env-writer.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-env-writer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('upsertEnvFile', () => {
  it('appends keys to an existing file when missing', () => {
    const p = join(dir, '.env.local');
    writeFileSync(p, 'EXISTING=foo\n');
    const r = upsertEnvFile(p, { NEXT_PUBLIC_POSTHOG_KEY: 'phc_abc' });
    expect(r.added).toEqual(['NEXT_PUBLIC_POSTHOG_KEY']);
    expect(readFileSync(p, 'utf-8')).toBe(
      'EXISTING=foo\nNEXT_PUBLIC_POSTHOG_KEY=phc_abc\n',
    );
  });

  it('creates the file when adding to a path that does not exist', () => {
    const p = join(dir, '.env.local');
    const r = upsertEnvFile(p, { FOO: 'bar' });
    expect(r.added).toEqual(['FOO']);
    expect(readFileSync(p, 'utf-8')).toBe('FOO=bar\n');
  });

  it('does not create a file when there is nothing to add', () => {
    const p = join(dir, '.env.local');
    const r = upsertEnvFile(p, {});
    expect(r.added).toEqual([]);
    expect(existsSync(p)).toBe(false);
  });

  it('skips keys whose value already matches', () => {
    const p = join(dir, '.env');
    writeFileSync(p, 'KEY=phc_abc\n');
    const r = upsertEnvFile(p, { KEY: 'phc_abc' });
    expect(r.skipped).toEqual(['KEY']);
    expect(r.added).toEqual([]);
    expect(readFileSync(p, 'utf-8')).toBe('KEY=phc_abc\n');
  });

  it('reports mismatches without overwriting', () => {
    const p = join(dir, '.env');
    writeFileSync(p, 'KEY=phc_old\n');
    const r = upsertEnvFile(p, { KEY: 'phc_new' });
    expect(r.mismatched).toEqual([
      { key: 'KEY', existingValue: 'phc_old', newValue: 'phc_new' },
    ]);
    expect(r.added).toEqual([]);
    expect(readFileSync(p, 'utf-8')).toBe('KEY=phc_old\n');
  });

  it('handles quoted existing values when comparing', () => {
    const p = join(dir, '.env');
    writeFileSync(p, 'KEY="phc_abc"\n');
    const r = upsertEnvFile(p, { KEY: 'phc_abc' });
    expect(r.skipped).toEqual(['KEY']);
  });

  it('appends a trailing newline if the file lacks one', () => {
    const p = join(dir, '.env');
    writeFileSync(p, 'EXISTING=foo'); // no trailing newline
    upsertEnvFile(p, { NEW: 'bar' });
    expect(readFileSync(p, 'utf-8')).toBe('EXISTING=foo\nNEW=bar\n');
  });
});
