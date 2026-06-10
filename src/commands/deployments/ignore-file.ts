import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';
import { CLIError } from '../../lib/errors.js';

export const IGNORE_FILE_NAME = '.vercelignore';

export interface DeployIgnore {
  /** Test a path relative to the deploy source dir. Directory paths must end with '/'. */
  ignores(relativePath: string): boolean;
  patternCount: number;
}

/**
 * Loads `.vercelignore` from the deploy source directory, if present.
 * Patterns follow .gitignore syntax. Returns null when the file does not exist.
 */
export async function loadDeployIgnore(sourceDir: string): Promise<DeployIgnore | null> {
  const ignoreFilePath = path.join(sourceDir, IGNORE_FILE_NAME);

  let raw: string;
  try {
    raw = await fs.readFile(ignoreFilePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new CLIError(
      `Failed to read ${IGNORE_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const matcher = ignore().add(raw);
  const patternCount = raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    }).length;

  return {
    ignores: (relativePath: string) => matcher.ignores(relativePath),
    patternCount,
  };
}
