import type { Command } from 'commander';
import { listBranchesApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputTable, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';

export function registerBranchListCommand(branch: Command): void {
  branch
    .command('list')
    .description('List branches of the currently linked project')
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const project = getProjectConfig();
        if (!project) {
          throw new CLIError('No project linked. Run `insforge link` first.');
        }
        // If currently switched onto a branch, list siblings of its parent.
        const parentId = project.branched_from?.project_id ?? project.project_id;
        const branches = await listBranchesApi(parentId, apiUrl);
        captureEvent(parentId, 'cli_branch_list', { count: branches.length });

        if (json) {
          outputJson({ data: branches });
          return;
        }
        if (branches.length === 0) {
          outputInfo('No branches.');
          return;
        }
        const currentBranchId = project.branched_from ? project.project_id : null;
        const rows = branches.map(b => [
          b.id === currentBranchId ? '*' : ' ',
          b.name,
          b.branch_state,
          b.branch_metadata?.mode ?? '?',
          new Date(b.branch_created_at).toLocaleString(),
        ]);
        outputTable(['', 'Name', 'State', 'Mode', 'Created'], rows);
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
