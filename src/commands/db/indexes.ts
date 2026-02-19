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

export function registerDbIndexesCommand(dbCmd: Command): void {
  dbCmd
    .command('indexes')
    .description('List all database indexes')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch('/api/database/indexes');
        const raw = await res.json() as unknown;
        const indexes = extractArray(raw);

        if (json) {
          outputJson(raw);
        } else {
          if (indexes.length === 0) {
            console.log('No database indexes found.');
            return;
          }
          outputTable(
            ['Name', 'Table', 'Columns', 'Unique', 'Primary'],
            indexes.map((i) => [
              str(i.name),
              str(i.tableName),
              str(i.columns),
              i.isUnique ? 'Yes' : 'No',
              i.isPrimary ? 'Yes' : 'No',
            ]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
