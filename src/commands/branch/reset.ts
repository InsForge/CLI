import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { listBranchesApi, resetBranchApi, getBranchApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import type { Branch } from '../../types.js';

const POLL_INTERVAL_MS = 3_000;
// Reset re-runs pg_restore in-place, plus (for schema-only) the truncate
// finalize. Same order of magnitude as create — minutes for a small DB,
// longer for a populated one. Match create's 5-min budget.
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export function registerBranchResetCommand(branch: Command): void {
  branch
    .command('reset <name>')
    .description("Reset a branch's database back to T0 (the parent snapshot at branch creation)")
    .option('-y, --yes', 'Skip confirmation')
    .action(async (name: string, opts: { yes?: boolean }, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const project = getProjectConfig();
        if (!project) throw new CLIError('No project linked. Run `insforge link` first.');

        // Resolve branch by name. parent_id flips depending on whether the
        // directory is currently switched onto a branch.
        const parentId = project.branched_from?.project_id ?? project.project_id;
        const branches = await listBranchesApi(parentId, apiUrl);
        const target = branches.find(b => b.name === name);
        if (!target) throw new CLIError(`Branch '${name}' not found.`);

        if (target.branch_state !== 'ready' && target.branch_state !== 'merged') {
          throw new CLIError(
            `Branch '${name}' is in '${target.branch_state}' state; reset requires 'ready' or 'merged'.`,
          );
        }
        const entryState = target.branch_state;

        if (!opts.yes && !json) {
          const confirmed = await clack.confirm({
            message:
              `Reset branch '${name}' back to T0? This wipes all schema/data/policy/function/migration changes made on the branch since creation.` +
              (entryState === 'merged'
                ? ' (Branch is currently merged — reset will reopen it for further work.)'
                : ''),
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        const initial = await resetBranchApi(target.id, apiUrl);
        captureEvent(parentId, 'cli_branch_reset', {
          entry_state: entryState,
          mode: target.branch_metadata?.mode,
        });

        if (!json) {
          outputSuccess(`Reset enqueued for branch '${name}'. Restoring T0…`);
        }

        const final = await pollUntilReady(target.id, apiUrl, !json, initial.branch_state);

        if (json) {
          outputJson({ branch: final });
        } else if (final.branch_state === 'ready') {
          outputSuccess(`Branch '${name}' is back to T0 and ready.`);
          outputInfo('⚠ Reminder: edge functions, website, and compute aren’t touched by reset; redeploy if needed.');
        } else {
          outputInfo(
            `Branch '${name}' is still in '${final.branch_state}' state. Run \`insforge branch list\` to check.`,
          );
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}

async function pollUntilReady(
  branchId: string,
  apiUrl: string | undefined,
  showProgress: boolean,
  startingState: string,
): Promise<Branch> {
  const start = Date.now();
  let lastState = startingState;
  if (showProgress) outputInfo(`  state: ${startingState}…`);
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const branch = await getBranchApi(branchId, apiUrl);
    // Reset always lands at ready (even when entry was merged) — see
    // backend BranchQueue.processResetFinalize. A bounce back to ready
    // OR merged is the rollback path; treat both as terminal so the user
    // sees the final state without a 5-minute wait.
    if (branch.branch_state === 'ready') return branch;
    if (branch.branch_state === 'merged') return branch;
    if (branch.branch_state === 'deleted' || branch.branch_state === 'conflicted') {
      throw new CLIError(`Branch reset failed (state: ${branch.branch_state})`);
    }
    if (showProgress && branch.branch_state !== lastState) {
      outputInfo(`  state: ${branch.branch_state}…`);
      lastState = branch.branch_state;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  // Timed out — re-check terminal failure states so a state flip just before
  // the deadline is not silently reported as “still in state …”.
  const branch = await getBranchApi(branchId, apiUrl);
  if (branch.branch_state === 'deleted' || branch.branch_state === 'conflicted') {
    throw new CLIError(`Branch reset failed (state: ${branch.branch_state})`);
  }
  return branch;
}
