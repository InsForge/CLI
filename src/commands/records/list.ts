import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { schemaProfileHeaders } from './profile.js';

export function registerRecordsCommands(recordsCmd: Command): void {
  recordsCmd
    .command('list <table>')
    .description('List records from a table')
    .option('--select <columns>', 'Columns to select (comma-separated)')
    .option('--filter <filter>', 'Filter expression (e.g. "name=eq.John")')
    .option('--order <order>', 'Order by (e.g. "created_at.desc")')
    .option('--limit <n>', 'Limit number of records', parseInt)
    .option('--offset <n>', 'Offset for pagination', parseInt)
    .option('--schema <name>', 'Schema to target (default: public)')
    .action(async (table: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const params = new URLSearchParams();
        if (opts.select) params.set('select', opts.select);
        if (opts.filter) params.set(opts.filter.split('=')[0], opts.filter.split('=').slice(1).join('='));
        if (opts.order) params.set('order', opts.order);
        if (opts.limit) params.set('limit', String(opts.limit));
        if (opts.offset) params.set('offset', String(opts.offset));

        const query = params.toString();
        const path = `/api/database/records/${encodeURIComponent(table)}${query ? `?${query}` : ''}`;
        const res = await ossFetch(path, { headers: schemaProfileHeaders('read', opts.schema) });
        const data = await res.json() as { data?: Record<string, unknown>[] };
        const records = data.data ?? [];

        await trackCommandUsage('records', 'list', true, {
          result_count: records.length,
        });

        if (json) {
          outputJson(data);
        } else {
          if (records.length === 0) {
            console.log('No records found.');
            return;
          }
          const headers = Object.keys(records[0]);
          outputTable(
            headers,
            records.map((r) => headers.map((h) => {
              const val = r[h];
              if (val === null || val === undefined) return '';
              if (typeof val === 'object') return JSON.stringify(val);
              return String(val);
            })),
          );
          console.log(`${records.length} record(s).`);
        }
      } catch (err) {
        await trackCommandUsage('records', 'list', false, {}, err);
        handleError(err, json);
      }
    });
}
