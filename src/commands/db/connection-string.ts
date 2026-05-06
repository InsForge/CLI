import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import type { ConnectionStringResponse } from '../../types.js';

export function registerDbConnectionStringCommand(dbCmd: Command): void {
  dbCmd
    .command('connection-string')
    .description('Print the project Postgres connection URL (cloud projects only)')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        const res = await ossFetch('/api/metadata/database-connection-string');
        const body = (await res.json()) as ConnectionStringResponse;
        if (json) {
          outputJson(body);
        } else {
          console.log(body.connectionURL);
        }
        await reportCliUsage('cli.db.connection-string', true);
      } catch (err) {
        await reportCliUsage('cli.db.connection-string', false);
        handleError(err, json);
      }
    });
}
