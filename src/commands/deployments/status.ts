import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError, getDeploymentError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { DeploymentSchema } from '../../types.js';

export function registerDeploymentsStatusCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('status <id>')
    .description('Get deployment details and sync status from Vercel')
    .option('--sync', 'Sync status from Vercel before showing')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        // Optionally sync status from Vercel first
        if (opts.sync) {
          await ossFetch(`/api/deployments/${id}/sync`, { method: 'POST' });
        }

        const res = await ossFetch(`/api/deployments/${id}`);
        const d = (await res.json()) as DeploymentSchema;

        if (json) {
          outputJson(d);
        } else {
          const errorMessage = getDeploymentError(d.metadata);
          outputTable(
            ['Field', 'Value'],
            [
              ['ID', d.id],
              ['Status', d.status],
              ['Provider', d.provider ?? '-'],
              ['Provider ID', d.providerDeploymentId ?? '-'],
              ['URL', d.url ?? '-'],
              ['Created', new Date(d.createdAt).toLocaleString()],
              ['Updated', new Date(d.updatedAt).toLocaleString()],
              ...(errorMessage ? [['Error', errorMessage]] : []),
            ],
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
