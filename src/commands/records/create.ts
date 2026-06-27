import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { schemaProfileHeaders } from './profile.js';

export function registerRecordsCreateCommand(recordsCmd: Command): void {
  recordsCmd
    .command('create <table>')
    .description('Create record(s) in a table')
    .option('--data <json>', 'JSON data to insert (object or array of objects)')
    .option('--schema <name>', 'Schema to target (default: public)')
    .action(async (table: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!opts.data) {
          throw new CLIError('--data is required. Example: --data \'{"name":"John"}\'');
        }

        let records: unknown[];
        try {
          const parsed = JSON.parse(opts.data) as unknown;
          records = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          throw new CLIError('Invalid JSON in --data. Provide a JSON object or array.');
        }

        const res = await ossFetch(
          `/api/database/records/${encodeURIComponent(table)}?return=representation`,
          {
            method: 'POST',
            body: JSON.stringify(records),
            headers: schemaProfileHeaders('write', opts.schema),
          },
        );

        const data = await res.json() as { data?: unknown[] };

        await trackCommandUsage('records', 'create', true);

        if (json) {
          outputJson(data);
        } else {
          const created = data.data ?? [];
          outputSuccess(`Created ${created.length || records.length} record(s) in "${table}".`);
        }
      } catch (err) {
        await trackCommandUsage('records', 'create', false, {}, err);
        handleError(err, json);
      }
    });
}
