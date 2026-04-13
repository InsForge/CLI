import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputTable, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

interface EnvVar {
  id: string;
  key: string;
  type: string;
  updatedAt: number;
}

export function registerDeploymentsEnvVarsCommand(deploymentsCmd: Command): void {
  const envCmd = deploymentsCmd.command('env').description('Manage deployment environment variables');

  // list
  envCmd
    .command('list')
    .description('List all deployment environment variables')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const res = await ossFetch('/api/deployments/env-vars');
        const data = (await res.json()) as { envVars: EnvVar[] };
        const envVars = data.envVars ?? [];

        if (json) {
          outputJson(data);
        } else {
          if (!envVars.length) {
            console.log('No environment variables found.');
            return;
          }
          outputTable(
            ['ID', 'Key', 'Type', 'Updated At'],
            envVars.map((v) => [
              v.id,
              v.key,
              v.type,
              new Date(v.updatedAt).toLocaleString(),
            ]),
          );
        }
        await reportCliUsage('cli.deployments.env.list', true);
      } catch (err) {
        await reportCliUsage('cli.deployments.env.list', false);
        handleError(err, json);
      }
    });

  // create / update
  envCmd
    .command('set <key> <value>')
    .description('Create or update a deployment environment variable')
    .action(async (key: string, value: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const res = await ossFetch('/api/deployments/env-vars', {
          method: 'POST',
          body: JSON.stringify({ envVars: [{ key, value }] }),
        });
        const data = (await res.json()) as { success: boolean; message: string; count: number };

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message);
        }
        await reportCliUsage('cli.deployments.env.set', true);
      } catch (err) {
        await reportCliUsage('cli.deployments.env.set', false);
        handleError(err, json);
      }
    });

  // delete
  envCmd
    .command('delete <id>')
    .description('Delete a deployment environment variable by ID')
    .action(async (id: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const res = await ossFetch(`/api/deployments/env-vars/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const data = (await res.json()) as { success: boolean; message: string };

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(data.message);
        }
        await reportCliUsage('cli.deployments.env.delete', true);
      } catch (err) {
        await reportCliUsage('cli.deployments.env.delete', false);
        handleError(err, json);
      }
    });
}
