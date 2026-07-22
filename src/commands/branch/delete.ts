import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { listBranchesApi, deleteBranchApi, getBranchApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { runBranchSwitch } from './switch.js';

// Retry configuration for deleting busy branches
const DELETE_RETRY_INTERVAL_MS = 30_000; // 30 seconds
const DELETE_MAX_RETRY_TIME_MS = 6 * 60 * 1_000; // 6 minutes max

function isBusyError(err: unknown): boolean {
  if (!(err instanceof CLIError)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('busy') || 
         msg.includes('creating') || 
         msg.includes('merging') ||
         msg.includes('currently busy');
}

async function waitForBranchDeletable(
  branchId: string, 
  apiUrl: string | undefined,
  spinner: ReturnType<typeof clack.spinner> | null
): Promise<void> {
  const start = Date.now();
  
  while (Date.now() - start < DELETE_MAX_RETRY_TIME_MS) {
    const branch = await getBranchApi(branchId, apiUrl);
    if (branch.branch_state !== 'creating' && branch.branch_state !== 'merging') {
      return; // Branch is no longer busy
    }
    
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    const remainingSec = Math.floor((DELETE_MAX_RETRY_TIME_MS - (Date.now() - start)) / 1000);
    spinner?.message(`Branch is ${branch.branch_state}, waiting to be deletable... (${remainingSec}s remaining)`);
    
    await new Promise(r => setTimeout(r, DELETE_RETRY_INTERVAL_MS));
  }
  
  // Final check - if still busy, throw a clear error
  const branch = await getBranchApi(branchId, apiUrl);
  if (branch.branch_state === 'creating' || branch.branch_state === 'merging') {
    throw new CLIError(
      `Branch is still ${branch.branch_state} after ${DELETE_MAX_RETRY_TIME_MS / 60000} minutes. ` +
      `The branch may need more time to finish provisioning. ` +
      `Try \`insforge branch delete ${branch.name}\` again in a few minutes.`,
      1,
      'BRANCH_STILL_BUSY'
    );
  }
}

async function deleteBranchWithRetry(
  branchId: string,
  apiUrl: string | undefined,
  spinner: ReturnType<typeof clack.spinner> | null
): Promise<void> {
  try {
    await deleteBranchApi(branchId, apiUrl);
    spinner?.stop(`Branch deletion requested.`);
  } catch (err) {
    if (isBusyError(err)) {
      spinner?.message(`Branch is busy (creating/merging). Waiting for it to become deletable...`);
      await waitForBranchDeletable(branchId, apiUrl, spinner);
      // Retry deletion after branch is no longer busy
      await deleteBranchApi(branchId, apiUrl);
      spinner?.stop(`Branch deletion requested after wait.`);
    } else {
      throw err;
    }
  }
}

export function registerBranchDeleteCommand(branch: Command): void {
  branch
    .command('delete <name>')
    .description('Delete a branch')
    .action(async (name: string, _opts: Record<string, never>, cmd) => {
      const { json, apiUrl, yes } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const project = getProjectConfig();
        if (!project) throw new CLIError('No project linked. Run `insforge link` first.');

        const parentId = project.branched_from?.project_id ?? project.project_id;
        const branches = await listBranchesApi(parentId, apiUrl);
        const target = branches.find(b => b.name === name);
        if (!target) throw new CLIError(`Branch '${name}' not found.`);

        if (!yes && !json) {
          const confirmed = await clack.confirm({
            message: `Delete branch '${name}'? This terminates its EC2 instance.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        // Set up spinner for progress indication during delete/retry
        const spinner = !json ? clack.spinner() : null;
        spinner?.start(`Deleting branch '${name}'...`);
        
        await deleteBranchWithRetry(target.id, apiUrl, spinner);
        captureEvent(parentId, 'cli_branch_delete', {});

        // If the directory is currently switched onto the deleted branch,
        // flip back to parent so subsequent commands don't operate on a
        // dead instance.
        const currentlyOnDeleted = project.project_id === target.id;
        if (currentlyOnDeleted) {
          try {
            // silent in JSON mode so we don't emit two JSON documents — the
            // single `outputJson({ deleted, ... })` below is authoritative.
            await runBranchSwitch({ toParent: true, apiUrl, json, silent: json });
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
