import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { DatabaseFunctionsResponse } from '../../types.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerDbFunctionsCommand(dbCmd: Command): void {
  dbCmd
    .command('functions')
    .description('List all database functions')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/database/functions');
        const raw = await res.json();
        const functions: DatabaseFunctionsResponse['functions'] = Array.isArray(raw)
          ? raw
          : (raw as DatabaseFunctionsResponse).functions ?? [];

        await trackCommandUsage('db', 'functions', true, { result_count: functions.length });

        if (json) {
          outputJson(raw);
        } else {
          if (functions.length === 0) {
            console.log('No database functions found.');
            return;
          }
          outputTable(
            ['Name', 'Definition', 'Kind'],
            functions.map((f) => [f.functionName, f.functionDef, f.kind]),
          );
        }
        await reportCliUsage('cli.db.functions', true);
      } catch (err) {
        await reportCliUsage('cli.db.functions', false);
        await trackCommandUsage('db', 'functions', false, {}, err);
        handleError(err, json);
      }
    });
}
