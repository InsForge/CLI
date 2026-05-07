import { describe, expect, it } from 'vitest';
import { extractEnvKeys, extractEnvPairs, filterCollidingEnvLines, refreshStaleEnvDefaults } from './apply.js';

describe('extractEnvKeys', () => {
  it('finds plain KEY=value lines', () => {
    const keys = extractEnvKeys('FOO=1\nBAR=2\n');
    expect(keys).toEqual(new Set(['FOO', 'BAR']));
  });

  it('ignores comments and blank lines', () => {
    const keys = extractEnvKeys('# header\n\nFOO=1\n# BAZ=2 (commented out)\nBAR=2\n');
    expect(keys).toEqual(new Set(['FOO', 'BAR']));
  });

  it('handles `export KEY=value` form', () => {
    const keys = extractEnvKeys('export FOO=1\n  export BAR=2\n');
    expect(keys).toEqual(new Set(['FOO', 'BAR']));
  });

  it('returns empty set for empty content', () => {
    expect(extractEnvKeys('')).toEqual(new Set());
    expect(extractEnvKeys('# only a comment\n')).toEqual(new Set());
  });
});

describe('filterCollidingEnvLines', () => {
  it('drops KEY=value lines whose key is already defined', () => {
    const append = '# header\nFOO=new\nBAR=new\n';
    const { filtered, dropped } = filterCollidingEnvLines(append, new Set(['FOO']));
    expect(dropped).toEqual(['FOO']);
    expect(filtered).toBe('# header\nBAR=new\n');
  });

  it('keeps comments and blank lines verbatim even when every var collides', () => {
    const append = '# section header\n# explanation\nFOO=1\nBAR=2\n';
    const { filtered, dropped } = filterCollidingEnvLines(append, new Set(['FOO', 'BAR']));
    expect(dropped).toEqual(['FOO', 'BAR']);
    expect(filtered).toBe('# section header\n# explanation\n');
  });

  it('returns empty dropped list when there are no collisions', () => {
    const append = 'FOO=1\nBAR=2\n';
    const { filtered, dropped } = filterCollidingEnvLines(append, new Set(['BAZ']));
    expect(dropped).toEqual([]);
    expect(filtered).toBe(append);
  });
});

describe('extractEnvPairs', () => {
  it('returns KEY → value pairs', () => {
    const m = extractEnvPairs('FOO=1\nBAR=hello world\n');
    expect(m.get('FOO')).toBe('1');
    expect(m.get('BAR')).toBe('hello world');
  });
  it('preserves URL-style values verbatim', () => {
    const m = extractEnvPairs('DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/insforge\n');
    expect(m.get('DATABASE_URL')).toBe('postgresql://postgres:postgres@127.0.0.1:5432/insforge');
  });
});

describe('refreshStaleEnvDefaults', () => {
  it('replaces user value when it matches manifest default and platform has real value', () => {
    const existing = 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/insforge\nFOO=keep-me\n';
    const defaults = new Map([
      ['DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/insforge'],
    ]);
    const platform = new Map([
      ['DATABASE_URL', 'postgresql://postgres:secret@cloud.host:5432/db?sslmode=require'],
    ]);
    const { updated, refreshed } = refreshStaleEnvDefaults(existing, defaults, platform);
    expect(refreshed).toEqual(['DATABASE_URL']);
    expect(updated).toContain('DATABASE_URL=postgresql://postgres:secret@cloud.host:5432/db?sslmode=require');
    expect(updated).not.toContain('127.0.0.1');
    expect(updated).toContain('FOO=keep-me');
  });

  it('preserves user value when it differs from the manifest default', () => {
    const existing = 'DATABASE_URL=postgresql://customized@host/db\n';
    const defaults = new Map([
      ['DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/insforge'],
    ]);
    const platform = new Map([
      ['DATABASE_URL', 'postgresql://cloud@host/db?sslmode=require'],
    ]);
    const { updated, refreshed } = refreshStaleEnvDefaults(existing, defaults, platform);
    expect(refreshed).toEqual([]);
    expect(updated).toContain('postgresql://customized@host/db');
  });

  it('skips refresh when platform has no real value (self-hosted, helper returned null)', () => {
    const existing = 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/insforge\n';
    const defaults = new Map([
      ['DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/insforge'],
    ]);
    const platform = new Map([
      ['DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/insforge'],
    ]);
    const { updated, refreshed } = refreshStaleEnvDefaults(existing, defaults, platform);
    expect(refreshed).toEqual([]);
    expect(updated).toBe(existing);
  });

  it('handles multiple keys, refreshing only the stale ones', () => {
    const existing = [
      'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/insforge',
      'BETTER_AUTH_SECRET=user-set-this-already',
      'INSFORGE_JWT_SECRET=replace-with-output-of-cli-secrets-get-JWT_SECRET',
    ].join('\n') + '\n';
    const defaults = new Map([
      ['DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/insforge'],
      ['BETTER_AUTH_SECRET', 'replace-with-32-random-bytes'],
      ['INSFORGE_JWT_SECRET', 'replace-with-output-of-cli-secrets-get-JWT_SECRET'],
    ]);
    const platform = new Map([
      ['DATABASE_URL', 'postgresql://cloud@host/db?sslmode=require'],
      ['BETTER_AUTH_SECRET', 'random-bytes-1234'],
      ['INSFORGE_JWT_SECRET', 'real-jwt-secret-from-platform'],
    ]);
    const { updated, refreshed } = refreshStaleEnvDefaults(existing, defaults, platform);
    expect(refreshed.sort()).toEqual(['DATABASE_URL', 'INSFORGE_JWT_SECRET']);
    expect(updated).toContain('DATABASE_URL=postgresql://cloud@host/db?sslmode=require');
    expect(updated).toContain('BETTER_AUTH_SECRET=user-set-this-already');
    expect(updated).toContain('INSFORGE_JWT_SECRET=real-jwt-secret-from-platform');
  });
});
