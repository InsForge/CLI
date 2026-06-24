import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { DatabaseTriggersResponse } from '../../types.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerDbTriggersCommand(dbCmd: Command): void {
  dbCmd
    .command('triggers')
    .description('List all database triggers')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/database/triggers');
        const raw = await res.json();
        const triggers: DatabaseTriggersResponse['triggers'] = Array.isArray(raw)
          ? raw
          : (raw as DatabaseTriggersResponse).triggers ?? [];

        await trackCommandUsage('db', 'triggers', true, { result_count: triggers.length });

        if (json) {
          outputJson(raw);
        } else {
          if (triggers.length === 0) {
            console.log('No database triggers found.');
            return;
          }
          outputTable(
            ['Name', 'Table', 'Timing', 'Events', 'ActionOrientation', 'ActionCondition', 'ActionStatement'],
            triggers.map((t) => [
              t.triggerName,
              t.tableName,
              t.actionTiming,
              t.eventManipulation,
              t.actionOrientation,
              t.actionCondition ?? '-',
              t.actionStatement,
            ]),
          );
        }
        await reportCliUsage('cli.db.triggers', true);
      } catch (err) {
        await reportCliUsage('cli.db.triggers', false);
        await trackCommandUsage('db', 'triggers', false, {}, err);
        handleError(err, json);
      }
    });
}
