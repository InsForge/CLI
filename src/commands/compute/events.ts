import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

// `compute events <id>` returns Fly machine lifecycle events (start/stop/exit/
// restart) — not container stdout/stderr. The previous name `compute logs`
// was misleading; container log streaming is roadmap work and will reuse the
// freshly-vacated `logs` command name when it lands.
export function registerComputeEventsCommand(computeCmd: Command): void {
  computeCmd
    .command('events <id>')
    .description('Get compute service machine events (start/stop/exit/restart)')
    .option('--limit <n>', 'Max number of event entries', '50')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 1000));
        const res = await ossFetch(
          `/api/compute/services/${encodeURIComponent(id)}/events?limit=${limit}`,
        );
        const events = await res.json() as { timestamp: number; message: string }[];

        await trackCommandUsage('compute', 'events', true, {
          result_count: Array.isArray(events) ? events.length : 0,
        });

        if (json) {
          outputJson(events);
        } else {
          if (!Array.isArray(events) || events.length === 0) {
            console.log('No events found.');
            await reportCliUsage('cli.compute.events', true);
            return;
          }
          for (const entry of events) {
            const ts = new Date(entry.timestamp).toISOString();
            console.log(`${ts}  ${entry.message}`);
          }
        }
        await reportCliUsage('cli.compute.events', true);
      } catch (err) {
        await reportCliUsage('cli.compute.events', false);
        await trackCommandUsage('compute', 'events', false, {}, err);
        handleError(err, json);
      }
    });
}
