import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

function str(val: unknown): string {
  if (val === null || val === undefined) return '-';
  if (Array.isArray(val)) return val.join(', ');
  return String(val);
}

function extractArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const arr = Object.values(raw).find(Array.isArray);
    if (arr) return arr as Record<string, unknown>[];
  }
  return [];
}

export function registerDbFunctionsCommand(dbCmd: Command): void {
  dbCmd
    .command('functions')
    .description('List all database functions')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch('/api/database/functions');
        const raw = await res.json() as unknown;
        const functions = extractArray(raw);

        if (json) {
          outputJson(raw);
        } else {
          if (functions.length === 0) {
            console.log('No database functions found.');
            return;
          }
          outputTable(
            ['Name', 'Schema', 'Language', 'Return Type', 'Arguments'],
            functions.map((f) => [str(f.name), str(f.schema), str(f.language), str(f.returnType), str(f.arguments)]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
