import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

export function registerDbCommands(dbCmd: Command): void {
  dbCmd
    .command('query <sql>')
    .description('Execute a SQL query against the database')
    .option('--unrestricted', 'Use unrestricted mode (allows system table access)')
    .action(async (sql: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const endpoint = opts.unrestricted
          ? '/api/database/advance/rawsql/unrestricted'
          : '/api/database/advance/rawsql';

        const res = await ossFetch(endpoint, {
          method: 'POST',
          body: JSON.stringify({ query: sql }),
        });

        const data = await res.json() as { rows?: Record<string, unknown>[]; data?: Record<string, unknown>[] };

        if (json) {
          outputJson(data);
        } else {
          // Try to render as table if results are array of objects
          const rows = data.rows ?? data.data ?? null;
          if (rows && rows.length > 0) {
            const headers = Object.keys(rows[0]);
            outputTable(
              headers,
              rows.map((row) => headers.map((h) => String(row[h] ?? ''))),
            );
            console.log(`${rows.length} row(s) returned.`);
          } else {
            console.log('Query executed successfully.');
            if (rows && rows.length === 0) {
              console.log('No rows returned.');
            }
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
