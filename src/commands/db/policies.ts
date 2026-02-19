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

export function registerDbPoliciesCommand(dbCmd: Command): void {
  dbCmd
    .command('policies')
    .description('List all RLS policies')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch('/api/database/policies');
        const raw = await res.json() as unknown;
        const policies = extractArray(raw);

        if (json) {
          outputJson(raw);
        } else {
          if (policies.length === 0) {
            console.log('No RLS policies found.');
            return;
          }
          outputTable(
            ['Name', 'Table', 'Command', 'Roles', 'Using', 'With Check'],
            policies.map((p) => [
              str(p.name),
              str(p.tableName),
              str(p.command),
              str(p.roles),
              str(p.using),
              str(p.withCheck),
            ]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
