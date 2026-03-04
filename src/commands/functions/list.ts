import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { ListFunctionsResponse } from '../../types.js';

export function registerFunctionsCommands(functionsCmd: Command): void {
  functionsCmd
    .command('list')
    .description('List all edge functions')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/functions');
        const raw = await res.json();
        // API may return array directly or { functions: [...] }
        const functions: ListFunctionsResponse['functions'] = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object' && 'functions' in raw
            ? (raw as ListFunctionsResponse).functions ?? []
            : [];

        if (json) {
          outputJson(raw);
        } else {
          if (functions.length === 0) {
            console.log('No functions found.');
            return;
          }
          outputTable(
            ['Slug', 'Name', 'Status', 'Created At'],
            functions.map((f) => [
              f.slug,
              f.name ?? '-',
              f.status ?? '-',
              f.createdAt ? new Date(f.createdAt).toLocaleString() : '-',
            ]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
