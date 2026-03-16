import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import type { FunctionResponse } from '../../types.js';

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

        // Resolve source file
        const filePath = opts.file ?? join(process.cwd(), 'insforge', 'functions', slug, 'index.ts');
        if (!existsSync(filePath)) {
          throw new CLIError(
            `Source file not found: ${filePath}\n` +
            `Specify --file <path> or create ${join('insforge', 'functions', slug, 'index.ts')}`,
          );
        }

        const code = readFileSync(filePath, 'utf-8');
        const name = opts.name ?? slug;
        const description = opts.description ?? '';

        // Check if function exists
        let exists = false;
        try {
          await ossFetch(`/api/functions/${encodeURIComponent(slug)}`);
          exists = true;
        } catch {
          exists = false;
        }

        let res: Response;
        if (exists) {
          res = await ossFetch(`/api/functions/${encodeURIComponent(slug)}`, {
            method: 'PUT',
            body: JSON.stringify({ name, description, code }),
          });
        } else {
          res = await ossFetch('/api/functions', {
            method: 'POST',
            body: JSON.stringify({ slug, name, description, code }),
          });
        }

        const result = await res.json() as FunctionResponse;

        const deployFailed = result.deployment?.status === 'failed';

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
        handleError(err, json);
      }
    });
}
