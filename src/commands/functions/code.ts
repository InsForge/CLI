import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

interface FunctionDetails {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  code: string;
  status: string;
  created_at: string;
  updated_at: string;
  deployed_at: string | null;
}

export function registerFunctionsCodeCommand(functionsCmd: Command): void {
  functionsCmd
    .command('code <slug>')
    .description('Fetch and display the source code of an edge function')
    .action(async (slug: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch(`/api/functions/${encodeURIComponent(slug)}`);
        const fn = await res.json() as FunctionDetails;

        if (json) {
          outputJson(fn);
        } else {
          console.log(`Function: ${fn.name} (${fn.slug})`);
          console.log(`Status:   ${fn.status}`);
          if (fn.description) console.log(`Desc:     ${fn.description}`);
          if (fn.deployed_at) console.log(`Deployed: ${fn.deployed_at}`);
          console.log('---');
          console.log(fn.code);
        }

        await trackCommandUsage('functions', 'code', true);
      } catch (err) {
        await trackCommandUsage('functions', 'code', false, {}, err);
        handleError(err, json);
      }
    });
}
