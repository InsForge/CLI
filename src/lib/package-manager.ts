import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { PackageJsonShape } from './framework-detect.js';

const execAsync = promisify(exec);

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/**
 * Detect the project's package manager from lockfile presence.
 * Falls back to npm when no lockfile is found.
 */
export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) {
    return 'bun';
  }
  return 'npm';
}

/** Build the install command for a single package using the given manager. */
export function installCommand(pm: PackageManager, pkg: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm add ${pkg}`;
    case 'yarn':
      return `yarn add ${pkg}`;
    case 'bun':
      return `bun add ${pkg}`;
    case 'npm':
    default:
      return `npm install ${pkg}`;
  }
}

/**
 * Returns true if the given package is already in dependencies or devDependencies.
 */
export function hasPackage(pkg: PackageJsonShape | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

/** Run a package install command. Wraps errors with context. */
export async function runInstall(
  pm: PackageManager,
  pkgName: string,
  cwd: string,
): Promise<void> {
  const cmd = installCommand(pm, pkgName);
  await execAsync(cmd, { cwd, maxBuffer: 16 * 1024 * 1024 });
}
