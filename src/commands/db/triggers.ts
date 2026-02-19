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

export function registerDbTriggersCommand(dbCmd: Command): void {
  dbCmd
    .command('triggers')
    .description('List all database triggers')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch('/api/database/triggers');
        const raw = await res.json() as unknown;
        const triggers = extractArray(raw);

        if (json) {
          outputJson(raw);
        } else {
          if (triggers.length === 0) {
            console.log('No database triggers found.');
            return;
          }
          outputTable(
            ['Name', 'Table', 'Timing', 'Events', 'Function', 'Enabled'],
            triggers.map((t) => [
              str(t.name),
              str(t.tableName),
              str(t.timing),
              str(t.events),
              str(t.functionName),
              t.enabled ? 'Yes' : 'No',
            ]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
