import type { Command } from 'commander';
import * as prompts from '../../lib/prompts.js';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';

export function registerDeploymentsCancelCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('cancel <id>')
    .description('Cancel a deployment')
    .action(async (id: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        if (!yes && !json) {
          const confirmed = await prompts.confirm({
            message: `Cancel deployment ${id}?`,
          });
          if (prompts.isCancel(confirmed) || !confirmed) process.exit(0);
        }

        const res = await ossFetch(`/api/deployments/${id}/cancel`, { method: 'POST' });
        const result = await res.json();

        if (json) {
          outputJson(result);
        } else {
          outputSuccess(`Deployment ${id} cancelled.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
