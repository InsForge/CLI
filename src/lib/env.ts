import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Read environment variables from the first env file found in the directory.
 * Priority: .env.local > .env.production > .env
 */
export async function readEnvFile(cwd: string): Promise<Array<{ key: string; value: string }>> {
  const candidates = ['.env.local', '.env.production', '.env'];
  for (const name of candidates) {
    const filePath = path.join(cwd, name);
    const exists = await fs.stat(filePath).catch(() => null);
    if (!exists) continue;

    const content = await fs.readFile(filePath, 'utf-8');
    const vars: Array<{ key: string; value: string }> = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (key) vars.push({ key, value });
    }
    return vars;
  }
  return [];
}
