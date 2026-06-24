import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerDbRpcCommand(dbCmd: Command): void {
  dbCmd
    .command('rpc <functionName>')
    .description('Call a database function via RPC')
    .option('--data <json>', 'JSON body to pass as function parameters')
    .action(async (functionName: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body = opts.data ? JSON.stringify(JSON.parse(opts.data) as unknown) : undefined;

        const res = await ossFetch(`/api/database/rpc/${encodeURIComponent(functionName)}`, {
          method: body ? 'POST' : 'GET',
          ...(body ? { body } : {}),
        });

        const result = await res.json() as unknown;

        await trackCommandUsage('db', 'rpc', true);

        if (json) {
          outputJson(result);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        await reportCliUsage('cli.db.rpc', true);
      } catch (err) {
        await reportCliUsage('cli.db.rpc', false);
        await trackCommandUsage('db', 'rpc', false, {}, err);
        handleError(err, json);
      }
    });
}
