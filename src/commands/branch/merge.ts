import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import * as clack from '@clack/prompts';
import {
  listBranchesApi,
  mergeBranchDryRunApi,
  mergeBranchExecuteApi,
} from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';

interface MergeOptions {
  dryRun?: boolean;
  yes?: boolean;
  saveSql?: string;
}

export function registerBranchMergeCommand(branch: Command): void {
  branch
    .command('merge <name>')
    .description('Merge a branch back to its parent project')
    .option('--dry-run', 'Compute the diff and print rendered SQL; do not apply')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--save-sql <path>', 'Write rendered SQL preview to a file')
    .action(async (name: string, opts: MergeOptions, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const project = getProjectConfig();
        if (!project) throw new CLIError('No project linked. Run `insforge link` first.');

        // Resolve branch by name. parent_id flips depending on whether the
        // directory is currently on a branch.
        const parentId = project.branched_from?.project_id ?? project.project_id;
        const branches = await listBranchesApi(parentId, apiUrl);
        const target = branches.find(b => b.name === name);
        if (!target) throw new CLIError(`Branch '${name}' not found.`);

        // Always compute diff first (cheap, gives the user a preview).
        const diff = await mergeBranchDryRunApi(target.id, apiUrl);

        if (opts.saveSql) {
          writeFileSync(opts.saveSql, diff.rendered_sql);
          if (!json) outputInfo(`SQL preview saved to ${opts.saveSql}`);
        }

        if (!json) {
          console.log(diff.rendered_sql);
          console.log();
          outputInfo(
            `${diff.summary.added} added, ${diff.summary.modified} modified, ${diff.summary.conflicts} conflict(s).`,
          );
        }

        if (diff.summary.conflicts > 0) {
          captureEvent(parentId, 'cli_branch_merge_conflict', {
            conflicts: diff.summary.conflicts,
          });
          if (json) {
            outputJson({
              diff,
              applied: false,
              dryRun: !!opts.dryRun,
              error: 'merge_conflict',
            });
          } else {
            outputInfo('');
            outputInfo('Merge blocked: resolve conflicts before retrying.');
            for (const c of diff.conflicts) {
              outputInfo(`  - ${c.schema}.${c.object} [${c.type}] — ${c.hint}`);
            }
          }
          process.exit(2);
        }

        if (opts.dryRun) {
          captureEvent(parentId, 'cli_branch_merge', {
            dry_run: true,
            conflicts: 0,
            applied: false,
          });
          if (json) {
            outputJson({ diff, applied: false, dryRun: true });
          }
          return;
        }

        // Confirm before executing (unless --yes or --json).
        if (!opts.yes && !json) {
          const parentLabel = project.branched_from?.project_name ?? project.project_name;
          const confirmed = await clack.confirm({
            message: `Apply this merge to parent project '${parentLabel}'?`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Merge cancelled.');
            return;
          }
        }

        const result = await mergeBranchExecuteApi(target.id, apiUrl);
        if (!result.ok) {
          // Race: dry-run was clean but execute saw conflicts (parent moved).
          captureEvent(parentId, 'cli_branch_merge_conflict', {
            conflicts: result.conflict.diff.summary.conflicts,
          });
          if (json) {
            outputJson({
              diff: result.conflict.diff,
              applied: false,
              dryRun: false,
              error: 'merge_conflict',
            });
          } else {
            outputInfo('Merge blocked by a conflict that appeared between dry-run and apply:');
            for (const c of result.conflict.diff.conflicts) {
              outputInfo(`  - ${c.schema}.${c.object} [${c.type}] — ${c.hint}`);
            }
          }
          process.exit(2);
        }

        captureEvent(parentId, 'cli_branch_merge', {
          dry_run: false,
          conflicts: 0,
          applied: true,
        });

        if (json) {
          outputJson({ ...result.result, diff, applied: true, dryRun: false });
        } else {
          outputSuccess(`Merged. Branch '${name}' is now in 'merged' state.`);
          outputInfo('⚠ Reminder: redeploy edge functions, website, and compute as needed.');
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
