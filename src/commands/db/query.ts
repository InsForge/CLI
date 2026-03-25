import type { Command } from 'commander';
import { runRawSql } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerDbCommands(dbCmd: Command): void {
  dbCmd
    .command('query <sql>')
    .description('Execute a SQL query against the database')
    .option('--unrestricted', 'Use unrestricted mode (allows system table access)')
    .action(async (sql: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const { rows, raw } = await runRawSql(sql, !!opts.unrestricted);

        if (json) {
          outputJson(raw);
        } else {
          if (rows.length > 0) {
            const headers = Object.keys(rows[0]);
            outputTable(
              headers,
              rows.map((row) => headers.map((h) => String(row[h] ?? ''))),
            );
            console.log(`${rows.length} row(s) returned.`);
          } else {
            console.log('Query executed successfully.');
            if (rows.length === 0) {
              console.log('No rows returned.');
            }
          }
        }
        await reportCliUsage('cli.db.query', true);
      } catch (err) {
        await reportCliUsage('cli.db.query', false);
        handleError(err, json);
      }
    });
}
