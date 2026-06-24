import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerRecordsDeleteCommand(recordsCmd: Command): void {
  recordsCmd
    .command('delete <table>')
    .description('Delete records from a table matching a filter')
    .option('--filter <filter>', 'Filter expression (e.g. "id=eq.123")')
    .action(async (table: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!opts.filter) {
          throw new CLIError('--filter is required to prevent accidental deletion of all rows.');
        }

        const params = new URLSearchParams();
        params.set(opts.filter.split('=')[0], opts.filter.split('=').slice(1).join('='));
        params.set('return', 'representation');

        const res = await ossFetch(
          `/api/database/records/${encodeURIComponent(table)}?${params}`,
          { method: 'DELETE' },
        );

        const data = await res.json() as { data?: unknown[] };

        await trackCommandUsage('records', 'delete', true);

        if (json) {
          outputJson(data);
        } else {
          const deleted = data.data ?? [];
          outputSuccess(`Deleted ${deleted.length} record(s) from "${table}".`);
        }
      } catch (err) {
        await trackCommandUsage('records', 'delete', false, {}, err);
        handleError(err, json);
      }
    });
}
