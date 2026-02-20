import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { SiteDeployment } from '../../types.js';

export function registerDeploymentsStatusCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('status <id>')
    .description('Get deployment details and sync status from Vercel')
    .option('--sync', 'Sync status from Vercel before showing')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        // Optionally sync status from Vercel first
        if (opts.sync) {
          await ossFetch(`/api/deployments/${id}/sync`, { method: 'POST' });
        }

        const res = await ossFetch(`/api/deployments/${id}`);
        const d = (await res.json()) as SiteDeployment;

        if (json) {
          outputJson(d);
        } else {
          outputTable(
            ['Field', 'Value'],
            [
              ['ID', d.id],
              ['Status', d.status],
              ['Provider', d.provider ?? '-'],
              ['Provider ID', d.providerDeploymentId ?? '-'],
              ['URL', d.deploymentUrl ?? d.url ?? '-'],
              ['Created', new Date(d.createdAt).toLocaleString()],
              ['Updated', new Date(d.updatedAt).toLocaleString()],
              ...(d.error ? [['Error', d.error]] : []),
            ],
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
