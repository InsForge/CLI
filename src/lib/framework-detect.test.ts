import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectFramework,
  contextFromCwd,
  type DetectionContext,
  type PackageJsonShape,
} from './framework-detect.js';

function ctx(
  pkg: PackageJsonShape | null,
  dirs: string[] = [],
): DetectionContext {
  const set = new Set(dirs);
  return {
    pkg,
    hasDir: (rel: string): boolean => set.has(rel),
  };
}

describe('detectFramework', () => {
  it('returns next-app when next + app/ directory present', () => {
    const result = detectFramework(
      ctx({ dependencies: { next: '14.0.0' } }, ['app']),
    );
    expect(result).toBe('next-app');
  });

  it('returns next-app when next + src/app/ directory present', () => {
    const result = detectFramework(
      ctx({ dependencies: { next: '14.0.0' } }, ['src/app']),
    );
    expect(result).toBe('next-app');
  });

  it('returns next-pages when next + pages/ directory present', () => {
    const result = detectFramework(
      ctx({ dependencies: { next: '14.0.0' } }, ['pages']),
    );
    expect(result).toBe('next-pages');
  });

  it('returns next-pages when next + src/pages/ directory present', () => {
    const result = detectFramework(
      ctx({ dependencies: { next: '14.0.0' } }, ['src/pages']),
    );
    expect(result).toBe('next-pages');
  });

  it('prefers next-app when both app/ and pages/ exist', () => {
    const result = detectFramework(
      ctx({ dependencies: { next: '14.0.0' } }, ['app', 'pages']),
    );
    expect(result).toBe('next-app');
  });

  it('defaults to next-app when next is present but neither dir exists', () => {
    const result = detectFramework(ctx({ dependencies: { next: '14.0.0' } }));
    expect(result).toBe('next-app');
  });

  it('returns vite-react when vite + react are deps and next is absent', () => {
    const result = detectFramework(
      ctx({ dependencies: { vite: '5.0.0', react: '18.2.0' } }),
    );
    expect(result).toBe('vite-react');
  });

  it('treats devDependencies the same as dependencies', () => {
    const result = detectFramework(
      ctx({
        devDependencies: { vite: '5.0.0' },
        dependencies: { react: '18.2.0' },
      }),
    );
    expect(result).toBe('vite-react');
  });

  it('returns sveltekit when @sveltejs/kit is present', () => {
    const result = detectFramework(
      ctx({ devDependencies: { '@sveltejs/kit': '2.0.0' } }),
    );
    expect(result).toBe('sveltekit');
  });

  it('returns astro when astro is present', () => {
    const result = detectFramework(
      ctx({ dependencies: { astro: '4.0.0' } }),
    );
    expect(result).toBe('astro');
  });

  it('returns null when no supported framework is present', () => {
    const result = detectFramework(
      ctx({ dependencies: { express: '4.0.0' } }),
    );
    expect(result).toBeNull();
  });

  it('returns null for a missing package.json', () => {
    expect(detectFramework(ctx(null))).toBeNull();
  });

  it('returns null when only react is present (no vite)', () => {
    const result = detectFramework(
      ctx({ dependencies: { react: '18.2.0' } }),
    );
    expect(result).toBeNull();
  });

  it('returns null when only vite is present (no react)', () => {
    const result = detectFramework(
      ctx({ dependencies: { vite: '5.0.0' } }),
    );
    expect(result).toBeNull();
  });

  it('next takes priority over vite when both are listed', () => {
    const result = detectFramework(
      ctx(
        {
          dependencies: { next: '14.0.0', vite: '5.0.0', react: '18.2.0' },
        },
        ['app'],
      ),
    );
    expect(result).toBe('next-app');
  });
});

describe('contextFromCwd', () => {
  it('reads package.json and detects directories from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fwk-detect-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ dependencies: { next: '14.0.0' } }),
      );
      mkdirSync(join(dir, 'app'));

      const c = contextFromCwd(dir);
      expect(c.pkg?.dependencies?.next).toBe('14.0.0');
      expect(c.hasDir('app')).toBe(true);
      expect(c.hasDir('pages')).toBe(false);
      expect(detectFramework(c)).toBe('next-app');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null pkg when package.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fwk-detect-'));
    try {
      const c = contextFromCwd(dir);
      expect(c.pkg).toBeNull();
      expect(detectFramework(c)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles malformed package.json gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fwk-detect-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{not json}');
      const c = contextFromCwd(dir);
      expect(c.pkg).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
