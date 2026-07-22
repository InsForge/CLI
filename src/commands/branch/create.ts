import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { createBranchApi, getBranchApi, listBranchesApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { runBranchSwitch } from './switch.js';
import type { Branch, BranchMode } from '../../types.js';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const HEALTH_CHECK_TIMEOUT_MS = 15 * 60 * 1_000;

async function waitForDataPlaneReady(branch: Branch, spinner: ReturnType<typeof clack.spinner> | null): Promise<void> {
  const healthUrl = `https://${branch.appkey}.${branch.region}.insforge.app/api/health`;
  const start = Date.now();
  let lastError: string | null = null;

  while (Date.now() - start < HEALTH_CHECK_TIMEOUT_MS) {
    try {
      spinner?.message(`Waiting for data plane to be ready (${Math.ceil((HEALTH_CHECK_TIMEOUT_MS - (Date.now() - start)) / 60000)} min left)...`);
      const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.status === 'healthy' || data.status === 'ok') {
          return;
        }
        lastError = `Health check returned status: ${data.status}`;
      } else {
        lastError = `Health check failed: ${res.status} ${res.statusText}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }
  throw new CLIError(
    `Branch data plane did not become ready within 15 minutes. Last error: ${lastError}. ` +
    `The branch may still be provisioning. Run \`insforge branch list\` to check status.`,
    1,
    'BRANCH_DATA_PLANE_TIMEOUT'
  );
}

export function registerBranchCreateCommand(branch: Command): void {
  branch
    .command('create <name>')
    .description('Create a branch from the currently linked project')
    .option('--mode <mode>', 'full | schema-only', 'full')
    .option('--no-switch', 'Do not auto-switch context after creation')
    .option('--wait-ready', 'Wait for the branch data plane to be fully ready (up to 15 min)', true)
    .action(async (name: string, opts: { mode: string; switch: boolean; waitReady: boolean }, cmd) => {
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

          // If the branch is ready and wait-ready is enabled, wait for the data plane to be healthy
          if (provisioned && opts.waitReady) {
            spinner?.message('Branch control plane ready. Waiting for data plane to be healthy...');
            await waitForDataPlaneReady(ready, spinner);
            spinner?.message('Data plane is ready.');
          }

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
          // Check if this is a network error (fetch failed, ECONNRESET, etc.)
          // Match both raw undici error messages AND the formatted output of
          // formatFetchError (used by platformFetch), so reconciliation is
          // reachable regardless of which layer surfaces the error.
          // If so, attempt to reconcile by checking if the branch was actually created
          const isNetworkError = err instanceof CLIError && 
            (err.message.includes('fetch failed') || 
             err.message.includes('ECONNRESET') ||
             err.message.includes('ETIMEDOUT') ||
             err.message.includes('ENOTFOUND') ||
             err.message.includes('ECONNREFUSED') ||
             err.message.includes('UND_ERR_CONNECT_TIMEOUT') ||
             err.message.includes('UND_ERR_SOCKET') ||
             err.message.includes('timeout') ||
             // Formatted messages from formatFetchError (used by platformFetch)
             err.message.includes('was reset') ||
             err.message.includes('was refused') ||
             err.message.includes('timed out') ||
             err.message.includes('Cannot resolve') ||
             err.message.includes('Network error contacting') ||
             err.message.includes('TLS certificate error') ||
             err.code === 'BRANCH_DATA_PLANE_TIMEOUT');
          
          if (!provisioned && isNetworkError) {
            try {
              // Attempt reconciliation: check if branch exists in branch list
              // listBranchesApi handles undefined apiUrl (uses default platform URL)
              const branches = await listBranchesApi(project.project_id, apiUrl);
              const createdBranch = branches.find(b => b.name === name);
              if (createdBranch) {
                // Branch exists server-side despite network error
                spinner?.stop(
                  `Connection was interrupted, but branch '${name}' was created server-side (state: ${createdBranch.branch_state}). ` +
                  `It may still be provisioning. Run \`insforge branch list\` to check status.`,
                  1
                );
                // Output the branch info in JSON mode so automation can parse it
                if (json) {
                  outputJson({ branch: createdBranch, reconciled: true });
                }
                await shutdownAnalytics();
                return;
              }
            } catch (reconcileErr) {
              // Reconciliation failed, fall through to original error
            }
          }
          
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
