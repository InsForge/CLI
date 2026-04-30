import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { listBranchesApi, deleteBranchApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { runBranchSwitch } from './switch.js';

export function registerBranchDeleteCommand(branch: Command): void {
  branch
    .command('delete <name>')
    .description('Delete a branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (name: string, opts: { yes?: boolean }, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const project = getProjectConfig();
        if (!project) throw new CLIError('No project linked. Run `insforge link` first.');

        const parentId = project.branched_from?.project_id ?? project.project_id;
        const branches = await listBranchesApi(parentId, apiUrl);
        const target = branches.find(b => b.name === name);
        if (!target) throw new CLIError(`Branch '${name}' not found.`);

        if (!opts.yes && !json) {
          const confirmed = await clack.confirm({
            message: `Delete branch '${name}'? This terminates its EC2 instance.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        await deleteBranchApi(target.id, apiUrl);
        captureEvent(parentId, 'cli_branch_delete', {});

        // If the directory is currently switched onto the deleted branch,
        // flip back to parent so subsequent commands don't operate on a
        // dead instance.
        const currentlyOnDeleted = project.project_id === target.id;
        if (currentlyOnDeleted) {
          try {
            await runBranchSwitch({ toParent: true, apiUrl, json });
          } catch (err) {
            // Non-fatal: the branch is gone, but we can at least tell the user.
            outputInfo(
              `Switched-to-parent failed (${(err as Error).message}). Run \`insforge branch switch --parent\` manually.`,
            );
          }
        }

        if (json) {
          outputJson({ deleted: true, branch_id: target.id, switched_back: currentlyOnDeleted });
        } else {
          outputSuccess(`Branch '${name}' deletion enqueued.`);
          if (currentlyOnDeleted) outputInfo('Switched back to parent.');
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
