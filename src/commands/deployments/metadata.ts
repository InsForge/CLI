import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { DeploymentMetadataResponse } from '../../types.js';

export function registerDeploymentsMetadataCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('metadata')
    .description('Get current deployment metadata and domain URLs')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const res = await ossFetch('/api/deployments/metadata');
        const d = (await res.json()) as DeploymentMetadataResponse;

        if (json) {
          outputJson(d);
        } else {
          outputTable(
            ['Field', 'Value'],
            [
              ['Current Deployment', d.currentDeploymentId ?? '-'],
              ['Default Domain URL', d.defaultDomainUrl ?? '-'],
              ['Custom Domain URL', d.customDomainUrl ?? '-'],
            ],
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
