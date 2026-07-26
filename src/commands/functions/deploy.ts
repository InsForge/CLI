import { readFileSync, existsSync } from 'node:fs';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import type { FunctionResponse } from '../../types.js';

export function resolveDeployFilePath(opts: { file?: string }): string {
  if (!opts.file) {
    throw new CLIError('Missing required option: --file <path>');
  }
  if (!existsSync(opts.file)) {
    throw new CLIError(`Source file not found: ${opts.file}`);
  }
  return opts.file;
}

export function registerFunctionsDeployCommand(functionsCmd: Command): void {
  functionsCmd
    .command('deploy <slug>')
    .description('Deploy an edge function (create or update)')
    .option('--file <path>', 'Path to the function source file')
    .option('--name <name>', 'Function display name')
    .option('--description <desc>', 'Function description')
    .action(async (slug: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const filePath = resolveDeployFilePath(opts);

        const code = readFileSync(filePath, 'utf-8');
        const name = opts.name ?? slug;
        const description = opts.description ?? '';

        // Check if function exists. Only a 404 means "not found" — any other
        // failure (auth, network, 5xx) must surface instead of being misread
        // as "create new", which would end in a confusing POST conflict.
        let exists = false;
        try {
          await ossFetch(`/api/functions/${encodeURIComponent(slug)}`);
          exists = true;
        } catch (err) {
          if (!(err instanceof CLIError) || err.statusCode !== 404) throw err;
          exists = false;
        }

        const updateFunction = (): Promise<Response> =>
          ossFetch(`/api/functions/${encodeURIComponent(slug)}`, {
            method: 'PUT',
            body: JSON.stringify({ name, description, code }),
          });

        let res: Response;
        if (exists) {
          res = await updateFunction();
        } else {
          try {
            res = await ossFetch('/api/functions', {
              method: 'POST',
              body: JSON.stringify({ slug, name, description, code }),
            });
          } catch (err) {
            // The backend can still report the slug as taken (409) — e.g. the
            // existence check raced a concurrent create. Fall back to update,
            // per the command's create-or-update contract.
            if (!(err instanceof CLIError) || err.statusCode !== 409) throw err;
            exists = true;
            res = await updateFunction();
          }
        }

        const result = await res.json() as FunctionResponse;

        const deployFailed = result.deployment?.status === 'failed';

        if (!deployFailed) {
          await trackCommandUsage('functions', 'deploy', true);
        }

        if (json) {
          outputJson(result);
        } else {
          const action = exists ? 'updation' : 'creation';
          const resultStatus = result.success ? 'success' : 'failed';
          outputSuccess(`Function "${result.function.slug}" ${action} ${resultStatus}.`);
          if (result.deployment) {
            if (result.deployment.status === 'success') {
              console.log(`  Deployment: ${result.deployment.status}${result.deployment.url ? ` → ${result.deployment.url}` : ''}`);
            } else {
              console.log(`  Deployment: ${result.deployment.status}`);
              if (result.deployment.buildLogs?.length) {
                console.log('  Build logs:');
                for (const line of result.deployment.buildLogs) {
                  console.log(`    ${line}`);
                }
              }
            }
          }
        }
        if (deployFailed) throw new CLIError('Function deployment failed');
        await reportCliUsage('cli.functions.deploy', true);
      } catch (err) {
        await reportCliUsage('cli.functions.deploy', false);
        await trackCommandUsage('functions', 'deploy', false, {}, err);
        handleError(err, json);
      }
    });
}
