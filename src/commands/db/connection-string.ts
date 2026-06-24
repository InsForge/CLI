import type { Command } from 'commander';
import { getDatabaseConnectionString } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerDbConnectionStringCommand(dbCmd: Command): void {
  dbCmd
    .command('connection-string')
    .description('Print the project Postgres connection URL (cloud projects only)')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        const url = await getDatabaseConnectionString();
        if (!url) {
          throw new CLIError('Could not fetch the database connection string. This command requires a cloud project (self-hosted instances expose Postgres directly via your docker-compose).');
        }
        await trackCommandUsage('db', 'connection-string', true);
        if (json) {
          outputJson({ connectionURL: url });
        } else {
          console.log(url);
        }
        await reportCliUsage('cli.db.connection-string', true);
      } catch (err) {
        await reportCliUsage('cli.db.connection-string', false);
        await trackCommandUsage('db', 'connection-string', false, {}, err);
        handleError(err, json);
      }
    });
}
