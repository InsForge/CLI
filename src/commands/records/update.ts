import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { schemaProfileHeaders } from './profile.js';

export function registerRecordsUpdateCommand(recordsCmd: Command): void {
  recordsCmd
    .command('update <table>')
    .description('Update records in a table matching a filter')
    .option('--filter <filter>', 'Filter expression (e.g. "id=eq.123")')
    .option('--data <json>', 'JSON data to update')
    .option('--schema <name>', 'Schema to target (default: public)')
    .action(async (table: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!opts.filter) {
          throw new CLIError('--filter is required to prevent accidental updates to all rows.');
        }
        if (!opts.data) {
          throw new CLIError('--data is required. Example: --data \'{"name":"Jane"}\'');
        }

        let body: unknown;
        try {
          body = JSON.parse(opts.data) as unknown;
        } catch {
          throw new CLIError('Invalid JSON in --data.');
        }

        const params = new URLSearchParams();
        params.set(opts.filter.split('=')[0], opts.filter.split('=').slice(1).join('='));
        params.set('return', 'representation');

        const res = await ossFetch(
          `/api/database/records/${encodeURIComponent(table)}?${params}`,
          {
            method: 'PATCH',
            body: JSON.stringify(body),
            headers: schemaProfileHeaders('write', opts.schema),
          },
        );

        const data = await res.json() as { data?: unknown[] };

        await trackCommandUsage('records', 'update', true);

        if (json) {
          outputJson(data);
        } else {
          const updated = data.data ?? [];
          outputSuccess(`Updated ${updated.length} record(s) in "${table}".`);
        }
      } catch (err) {
        await trackCommandUsage('records', 'update', false, {}, err);
        handleError(err, json);
      }
    });
}
