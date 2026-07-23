import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { listBranchesApi, deleteBranchApi, getBranchApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { runBranchSwitch } from './switch.js';

const DELETE_RETRY_INTERVAL_MS = 30_000;
const DELETE_MAX_RETRY_TIME_MS = 6 * 60 * 1_000;

// Match on the server's structured error code if available; fall back to
// checking the response message only when no code is present. This avoids
// false positives from unrelated error text that happens to contain "busy".
function isBusyError(err: unknown): boolean {
  if (!(err instanceof CLIError)) return false;
  // Exact server error codes for busy/provisioning states
  if (err.code && ['BRANCH_BUSY', 'BRANCH_CREATING', 'BRANCH_MERGING', 'PROVISIONING_IN_PROGRESS'].includes(err.code)) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return msg.includes('branch is busy') ||
         msg.includes('currently busy') ||
         msg.includes('still creating') ||
         msg.includes('still merging');
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
      return;
    }
    
    const remainingSec = Math.floor((DELETE_MAX_RETRY_TIME_MS - (Date.now() - start)) / 1000);
    spinner?.message(`Branch is ${branch.branch_state}, waiting to be deletable... (${remainingSec}s remaining)`);
    
    // Cap sleep to the remaining time budget so we don't exceed the max
    const remainingBudget = DELETE_MAX_RETRY_TIME_MS - (Date.now() - start);
    const sleepMs = Math.min(DELETE_RETRY_INTERVAL_MS, Math.max(0, remainingBudget));
    await new Promise(r => setTimeout(r, sleepMs));
  }
  
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
  name: string,
  apiUrl: string | undefined,
  spinner: ReturnType<typeof clack.spinner> | null
): Promise<void> {
  try {
    try {
      await deleteBranchApi(branchId, apiUrl);
      spinner?.stop(`Branch deletion requested.`);
      return;
    } catch (err) {
      if (isBusyError(err)) {
        spinner?.message(`Branch is busy (creating/merging). Waiting for it to become deletable...`);
        await waitForBranchDeletable(branchId, apiUrl, spinner);
        await deleteBranchApi(branchId, apiUrl);
        spinner?.stop(`Branch deletion requested after wait.`);
        return;
      }
      throw err;
    }
  } catch (err) {
    spinner?.stop(`Branch '${name}' deletion failed`, 1);
    throw err;
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

        const spinner = !json ? clack.spinner() : null;
        spinner?.start(`Deleting branch '${name}'...`);
        
        await deleteBranchWithRetry(target.id, name, apiUrl, spinner);
        captureEvent(parentId, 'cli_branch_delete', {});

        const currentlyOnDeleted = project.project_id === target.id;
        if (currentlyOnDeleted) {
          try {
            await runBranchSwitch({ toParent: true, apiUrl, json, silent: json });
          } catch (err) {
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
