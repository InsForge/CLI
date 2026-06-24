import type { Command } from 'commander';
import { getOrgUsage } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { resolveOrgId } from '../../lib/resolve-org.js';
import { outputJson, outputTable, outputInfo } from '../../lib/output.js';
import { trackTopLevelUsage } from '../../lib/command-telemetry.js';

/** Render a byte count as a human-readable size. */
function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

const BYTE_METRICS = new Set(['database_bytes', 'storage_bytes', 'egress_bytes']);

function formatMetric(key: string, value: number): string {
  if (BYTE_METRICS.has(key)) return formatBytes(value);
  // Counts stay as integers; fractional metrics (e.g. ai_credits) round to 2dp
  // so we don't surface float noise like 69.82999999999998.
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function registerUsageCommand(program: Command): void {
  program
    .command('usage')
    .description('Show organization usage for the current billing period')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const usage = await getOrgUsage(orgId, apiUrl);

        await trackTopLevelUsage('usage', true);

        if (json) {
          outputJson(usage);
          return;
        }

        outputInfo(`Organization: ${usage.organization.name} (plan: ${usage.organization.price_plan})\n`);
        outputTable(
          ['Metric', 'Value'],
          Object.entries(usage.usage_summary).map(([k, v]) => [k, formatMetric(k, v)]),
        );

        if (usage.projects.length) {
          outputInfo('\nPer project:');
          outputTable(
            ['Project', 'Status', 'DB', 'Storage', 'Egress'],
            usage.projects.map((p) => [
              p.name,
              p.status,
              formatBytes(Number(p.database_bytes ?? 0)),
              formatBytes(Number(p.storage_bytes ?? 0)),
              formatBytes(Number(p.egress_bytes ?? 0)),
            ]),
          );
        }
      } catch (err) {
        await trackTopLevelUsage('usage', false, {}, err);
        handleError(err, json);
      }
    });
}
