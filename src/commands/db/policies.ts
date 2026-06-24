import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { DatabasePoliciesResponse } from '../../types.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerDbPoliciesCommand(dbCmd: Command): void {
  dbCmd
    .command('policies')
    .description('List all RLS policies')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/database/policies');
        const raw = await res.json();
        const policies: DatabasePoliciesResponse['policies'] = Array.isArray(raw)
          ? raw
          : (raw as DatabasePoliciesResponse).policies ?? [];

        await trackCommandUsage('db', 'policies', true, { result_count: policies.length });

        if (json) {
          outputJson(raw);
        } else {
          if (policies.length === 0) {
            console.log('No RLS policies found.');
            return;
          }
          outputTable(
            ['Table', 'Policy Name', 'Command', 'Roles', 'Qual', 'With Check'],
            policies.map((p) => [
              String(p.tableName ?? '-'),
              String(p.policyName ?? '-'),
              String(p.cmd ?? '-'),
              Array.isArray(p.roles) ? p.roles.join(', ') : String(p.roles ?? '-'),
              String(p.qual ?? '-'),
              String(p.withCheck ?? '-'),
            ]),
          );
        }
        await reportCliUsage('cli.db.policies', true);
      } catch (err) {
        await reportCliUsage('cli.db.policies', false);
        await trackCommandUsage('db', 'policies', false, {}, err);
        handleError(err, json);
      }
    });
}
