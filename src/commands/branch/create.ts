import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { createBranchApi, getBranchApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { runBranchSwitch } from './switch.js';
import type { Branch, BranchMode } from '../../types.js';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export function registerBranchCreateCommand(branch: Command): void {
  branch
    .command('create <name>')
    .description('Create a branch from the currently linked project')
    .option('--mode <mode>', 'full | schema-only', 'full')
    .option('--no-switch', 'Do not auto-switch context after creation')
    .action(async (name: string, opts: { mode: string; switch: boolean }, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const project = getProjectConfig();
        if (!project) {
          throw new CLIError('No project linked. Run `insforge link` first.');
        }
        // Disallow nested branching at the CLI layer (cloud-backend rejects too,
        // but a clear local error saves a round-trip).
        if (project.branched_from) {
          throw new CLIError(
            "This directory is currently switched to a branch. Run `insforge branch switch --parent` first, then create a new branch from the parent.",
          );
        }
        if (opts.mode !== 'full' && opts.mode !== 'schema-only') {
          throw new CLIError(`Invalid --mode: ${opts.mode} (must be "full" or "schema-only")`);
        }
        const mode = opts.mode as BranchMode;

        // Single spinner spans the slow POST, provisioning poll, and the
        // optional auto-switch. The user sees continuous progress instead of a
        // 2-minute silent hang, and a switch failure is rendered with the same
        // red error frame as a create failure (no misleading "ready" line
        // before an error). JSON mode skips the spinner — `outputJson({ branch:
        // ready })` below remains the sole authoritative output.
        const spinner = !json ? clack.spinner() : null;
        let ready: Branch;
        // Tracks whether the branch reached `ready` state in the cloud — once
        // true, any later throw is a switch failure (local), not a creation
        // failure. Lets the catch render an accurate message instead of the
        // misleading "creation failed" line for an already-created branch.
        let provisioned = false;
        try {
          spinner?.start(`Creating branch '${name}'...`);
          const created = await createBranchApi(project.project_id, { mode, name }, apiUrl);
          captureEvent(project.project_id, 'cli_branch_create', {
            mode,
            parent_project_id: project.project_id,
          });
          spinner?.message(`Branch '${name}' created (appkey: ${created.appkey}). Provisioning...`);
          ready = await pollUntilReady(created.id, apiUrl, spinner);
          provisioned = ready.branch_state === 'ready';

          if (provisioned && opts.switch) {
            spinner?.message('Branch ready. Switching context...');
            // silent: true always — the spinner owns user-facing output, and
            // runBranchSwitch's outputSuccess would otherwise interleave with
            // the active spinner frame.
            await runBranchSwitch({ name, apiUrl, json, silent: true });
            spinner?.stop(`Branch '${name}' is ready and active`);
          } else if (provisioned) {
            spinner?.stop(`Branch '${name}' is ready`);
          } else {
            spinner?.stop(`Branch '${name}' is in '${ready.branch_state}' state`);
          }
        } catch (err) {
          if (provisioned) {
            spinner?.stop(
              `Branch '${name}' is ready, but switching context failed — run \`insforge branch switch ${name}\` to retry`,
              1,
            );
          } else {
            spinner?.stop(`Branch '${name}' creation failed`, 1);
          }
          throw err;
        }

        if (json) {
          outputJson({ branch: ready });
        } else if (ready.branch_state === 'ready') {
          if (opts.switch) {
            outputInfo(
              '⚠ Re-source your dev server env (.env) to pick up the new INSFORGE_URL / ANON_KEY.',
            );
          }
        } else {
          outputInfo(
            `Branch '${name}' is still in '${ready.branch_state}' state. Run \`insforge branch list\` to check.`,
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
  spinner: ReturnType<typeof clack.spinner> | null,
): Promise<Branch> {
  const start = Date.now();
  let lastState = '';
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const branch = await getBranchApi(branchId, apiUrl);
    if (branch.branch_state === 'ready') return branch;
    if (branch.branch_state === 'deleted' || branch.branch_state === 'conflicted') {
      throw new CLIError(`Branch creation failed (state: ${branch.branch_state})`);
    }
    if (spinner && branch.branch_state !== lastState) {
      spinner.message(`Provisioning branch (state: ${branch.branch_state})...`);
      lastState = branch.branch_state;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  // Timed out — re-check terminal failure states so a state flip just before
  // the deadline is not silently reported as “still in state …”.
  const branch = await getBranchApi(branchId, apiUrl);
  if (branch.branch_state === 'deleted' || branch.branch_state === 'conflicted') {
    throw new CLIError(`Branch creation failed (state: ${branch.branch_state})`);
  }
  return branch;
}
