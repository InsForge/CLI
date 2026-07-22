import type { Command } from 'commander';
import { runRawSql, isProvisioningError, buildProvisioningErrorMessage } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { getProjectConfig } from '../../lib/config.js';

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

        await trackCommandUsage('db', 'query', true, { result_count: rows.length });

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
        await trackCommandUsage('db', 'query', false, {}, err);
        
        // Check if this is a provisioning error on a branch
        const projectConfig = getProjectConfig();
        const isBranch = projectConfig?.branched_from != null;
        const branchName = projectConfig?.project_name;
        
        if (isBranch && isProvisioningError(err)) {
          const msg = buildProvisioningErrorMessage(branchName);
          if (json) {
            console.error(JSON.stringify({ error: msg, code: 'BRANCH_PROVISIONING' }));
          } else {
            console.error(`Error: ${msg}`);
          }
          process.exit(1);
        }
        
        handleError(err, json);
      }
    });
}
