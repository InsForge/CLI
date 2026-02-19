import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

export function registerDbTablesCommand(dbCmd: Command): void {
  dbCmd
    .command('tables')
    .description('List all database tables')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch('/api/database/tables');
        const tables = await res.json() as string[];

        if (json) {
          outputJson(tables);
        } else {
          if (tables.length === 0) {
            console.log('No tables found.');
            return;
          }
          outputTable(
            ['Table Name'],
            tables.map((t) => [t]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
