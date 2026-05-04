import { describe, expect, it } from 'vitest';
import { extractEnvKeys, filterCollidingEnvLines } from './apply.js';

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
