import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Framework =
  | 'next-app'
  | 'next-pages'
  | 'vite-react'
  | 'sveltekit'
  | 'astro';

export interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface DetectionContext {
  /** Directory contents of the project root, used to check for `app/` and `pages/`. */
  hasDir: (relativePath: string) => boolean;
  /** Parsed package.json (or null if not present/parseable). */
  pkg: PackageJsonShape | null;
}

/**
 * Build a DetectionContext from a real filesystem directory. Used by the CLI;
 * tests construct contexts directly without touching disk.
 */
export function contextFromCwd(cwd: string): DetectionContext {
  let pkg: PackageJsonShape | null = null;
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJsonShape;
    } catch {
      pkg = null;
    }
  }
  return {
    hasDir: (rel: string): boolean => existsSync(join(cwd, rel)),
    pkg,
  };
}

function hasDep(pkg: PackageJsonShape | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

/**
 * Detect a supported web framework from a project's package.json + filesystem.
 *
 * Decision rules (in priority order):
 *   1. `next` + `app/` directory → next-app
 *   2. `next` + `pages/` directory → next-pages
 *   3. `next` only (no entry dir) → next-app (fallback default; caller may prompt)
 *   4. `vite` + `react` → vite-react
 *   5. `@sveltejs/kit` → sveltekit
 *   6. `astro` → astro
 *   7. otherwise → null
 *
 * Note: Next.js takes priority over Vite even if both happen to be present
 * (rare but possible in monorepos), because the `next` dependency is the more
 * specific signal. If users hit ambiguous cases the caller can prompt.
 */
export function detectFramework(ctx: DetectionContext): Framework | null {
  if (hasDep(ctx.pkg, 'next')) {
    const hasApp = ctx.hasDir('app') || ctx.hasDir('src/app');
    const hasPages = ctx.hasDir('pages') || ctx.hasDir('src/pages');
    if (hasApp && !hasPages) return 'next-app';
    if (hasPages && !hasApp) return 'next-pages';
    if (hasApp && hasPages) return 'next-app'; // App Router wins when both present
    return 'next-app'; // default for Next.js with neither dir yet (newly scaffolded)
  }

  if (hasDep(ctx.pkg, 'vite') && hasDep(ctx.pkg, 'react')) {
    return 'vite-react';
  }

  if (hasDep(ctx.pkg, '@sveltejs/kit')) {
    return 'sveltekit';
  }

  if (hasDep(ctx.pkg, 'astro')) {
    return 'astro';
  }

  return null;
}
