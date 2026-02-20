import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { SiteDeployment } from '../../types.js';

export function registerDeploymentsListCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('list')
    .description('List all deployments')
    .option('--limit <n>', 'Limit number of results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const res = await ossFetch(`/api/deployments?limit=${opts.limit}&offset=${opts.offset}`);
        const raw = await res.json() as unknown;

        // API may return array directly or { data: [...] }
        let deployments: Record<string, unknown>[];
        if (Array.isArray(raw)) {
          deployments = raw as Record<string, unknown>[];
        } else if (raw && typeof raw === 'object' && 'data' in raw && Array.isArray((raw as Record<string, unknown>).data)) {
          deployments = (raw as Record<string, unknown>).data as Record<string, unknown>[];
        } else {
          deployments = [];
        }

        if (json) {
          outputJson(raw);
        } else {
          if (!deployments.length) {
            console.log('No deployments found.');
            return;
          }
          outputTable(
            ['ID', 'Status', 'Provider', 'URL', 'Created'],
            deployments.map((d) => [
              String(d.id ?? '-'),
              String(d.status ?? '-'),
              String(d.provider ?? '-'),
              String(d.deploymentUrl ?? d.url ?? '-'),
              d.createdAt ?? d.created_at ? new Date(String(d.createdAt ?? d.created_at)).toLocaleString() : '-',
            ]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
