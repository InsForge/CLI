import type { Command } from 'commander';
import * as clack from '@clack/prompts';
<<<<<<< HEAD
import {
  createBranchApi,
  getBranchApi,
  listBranchesApi,
  NETWORK_ERROR_CODE,
} from '../../lib/api/platform.js';
import { probeBackendHealth } from '../../lib/api/oss.js';
=======
import { createBranchApi, getBranchApi, listBranchesApi } from '../../lib/api/platform.js';
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { buildOssHost, getProjectConfig } from '../../lib/config.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { runBranchSwitch } from './switch.js';
import type { Branch, BranchMode } from '../../types.js';

const POLL_INTERVAL_MS = 3_000;
<<<<<<< HEAD
// `branch_state` reaching 'ready' and the branch's own host answering are two
// different events, and the gap between them has been measured in MINUTES
// (2 min and 11.5 min on ap-southeast). A 5-minute ceiling reported the slower
// one as "still creating" when it was simply not finished yet, so the budget
// now covers the observed range with headroom.
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;
// Once the control plane says ready, wait for the data plane too. Until this
// passes, every subsequent command against the branch fails.
const HEALTH_TIMEOUT_MS = 10 * 60 * 1_000;
const HEALTH_INTERVAL_MS = 5_000;
// Tolerance for clock skew when deciding whether a branch is the one we just
// asked for. Generous on purpose: the cost of being slightly wide is adopting a
// branch someone created seconds ago under the same name; the cost of being too
// narrow is orphaning a billing resource, which is the bug this exists to fix.
const CREATED_AT_SKEW_MS = 60_000;
=======
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
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca

export function registerBranchCreateCommand(branch: Command): void {
  branch
    .command('create <name>')
    .description('Create a branch from the currently linked project')
    .option('--mode <mode>', 'full | schema-only', 'full')
    .option('--no-switch', 'Do not auto-switch context after creation')
<<<<<<< HEAD
    .option('--no-wait-ready', 'Skip waiting for data plane readiness (exit immediately after control plane confirms creation)')
=======
    .option('--wait-ready', 'Wait for the branch data plane to be fully ready (up to 15 min)', true)
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca
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
        // Whether the branch's own host answered. Separate from `provisioned`
        // because the branch can be genuinely created and genuinely unusable,
        // and the exit status has to reflect the second one.
        let serving = false;
        // Tracks whether the branch reached `ready` state in the cloud — once
        // true, any later throw is a switch failure (local), not a creation
        // failure. Lets the catch render an accurate message instead of the
        // misleading "creation failed" line for an already-created branch.
        let provisioned = false;
        try {
          spinner?.start(`Creating branch '${name}'...`);
          const requestedAt = Date.now() - CREATED_AT_SKEW_MS;
          const created = await createBranchOrAdopt(
            project.project_id,
            { mode, name },
            apiUrl,
            requestedAt,
          );
          captureEvent(project.project_id, 'cli_branch_create', {
            mode,
            parent_project_id: project.project_id,
          });
          spinner?.message(`Branch '${name}' created (appkey: ${created.appkey}). Provisioning...`);
          ready = await pollUntilReady(created.id, apiUrl, spinner);
          provisioned = ready.branch_state === 'ready';

<<<<<<< HEAD
          // 'ready' is a control-plane state: it means the provisioning job
          // returned, not that the branch answers. Confirm the data plane
          // before reporting success, otherwise the very next command the user
          // runs — including the auto-switch below — hits a host that resets.
          if (provisioned && opts.waitReady !== false) {
            spinner?.message('Branch ready. Waiting for it to start serving...');
            serving = await waitUntilServing(ready, spinner);
            if (!serving) provisioned = false;
          } else if (provisioned) {
            serving = true;
=======
          // If the branch is ready and wait-ready is enabled, wait for the data plane to be healthy
          if (provisioned && opts.waitReady) {
            spinner?.message('Branch control plane ready. Waiting for data plane to be healthy...');
            await waitForDataPlaneReady(ready, spinner);
            spinner?.message('Data plane is ready.');
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca
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
          } else if (ready.branch_state === 'ready') {
            spinner?.stop(
              `Branch '${name}' reports ready but is not serving yet — retry your next command shortly`,
              1,
            );
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

        // Emit the branch identity BEFORE any failure is raised: the branch
        // exists and is billing, so a caller must be able to find and delete it
        // even when this command is about to exit non-zero.
        if (json) {
          outputJson({ branch: ready, serving });
        } else if (ready.branch_state === 'ready' && serving) {
          if (opts.switch) {
            outputInfo(
              '⚠ Re-source your dev server env (.env) to pick up the new INSFORGE_URL / ANON_KEY.',
            );
          }
        } else if (ready.branch_state === 'ready') {
          outputInfo(
            `Branch '${name}' exists but its host is not serving yet. Run \`insforge branch list\` to check, or \`insforge branch delete ${name}\` to remove it.`,
          );
        } else {
          outputInfo(
            `Branch '${name}' is still in '${ready.branch_state}' state. Run \`insforge branch list\` to check.`,
          );
        }

        // Exit non-zero when the branch cannot be used. Reporting success here
        // is what lets automation continue straight into a host that resets —
        // the failure mode this whole change exists to remove. Two outcomes are
        // "not usable", and both must fail: the branch never finished
        // provisioning (still non-'ready' after the poll budget), and the branch
        // is 'ready' but its host never started serving.
        if (ready.branch_state !== 'ready') {
          throw new CLIError(
            `Branch '${name}' was created but did not finish provisioning (still '${ready.branch_state}') within ${
              Math.round(POLL_TIMEOUT_MS / 60_000)
            } minutes.`,
          );
        }
        if (!serving) {
          throw new CLIError(
            `Branch '${name}' was created but its host did not start serving within ${
              Math.round(HEALTH_TIMEOUT_MS / 60_000)
            } minutes.`,
          );
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}

/**
 * Create the branch, and if the request fails at the TRANSPORT layer, check
 * whether it was created anyway before giving up.
 *
 * `createBranchApi` carries no idempotency key, and a reset on the RESPONSE leg
 * leaves a fully created, billing branch behind while the CLI exits non-zero.
 * The caller then has no id, no name in the output, and no reason to believe
 * anything exists — so the branch is silently orphaned. `branch list` is
 * authoritative here, and it is a control-plane call, so it still works while
 * the branch's own host is unreachable.
 *
 * Two guards keep this from adopting something it did not create — a duplicate
 * name is a REJECTION, not a lost response, and adopting on it would switch the
 * caller into someone else's branch with a different mode and different data:
 *
 *   1. only a tagged transport failure is eligible; every HTTP/API rejection
 *      (duplicate name, quota, auth) rethrows untouched;
 *   2. the branch must have been created at or after the moment we sent the
 *      request, so a pre-existing same-name branch is never a candidate;
 *   3. the branch's mode must match what we asked for.
 *
 * Guard 3 narrows a residual collision the timestamp window alone cannot close:
 * a collaborator creating a same-name branch inside the skew window, at the same
 * moment our own request loses its response leg, would otherwise be adoptable —
 * and with the default `--switch` that would silently move local context onto
 * their branch. Requiring a mode match makes that require an even more specific
 * coincidence (same name AND same mode AND the same ~60s AND our transport
 * failure). The real fix is a server-issued idempotency/request token on
 * `createBranchApi`; until that exists, this is the tightest client-side guard.
 * Reported upstream: InsForge/InsForge#1790.
 */
function isTransportFailure(err: unknown): boolean {
  return err instanceof CLIError && err.code === NETWORK_ERROR_CODE;
}

async function createBranchOrAdopt(
  parentId: string,
  body: { mode: BranchMode; name: string },
  apiUrl: string | undefined,
  requestedAt: number,
): Promise<Branch> {
  try {
    return await createBranchApi(parentId, body, apiUrl);
  } catch (err) {
    if (!isTransportFailure(err)) throw err;
    const existing = await listBranchesApi(parentId, apiUrl)
      .then(branches =>
        branches.find(
          branch =>
            branch.name === body.name &&
            branch.branch_metadata?.mode === body.mode &&
            Date.parse(branch.branch_created_at) >= requestedAt,
        ),
      )
      .catch(() => undefined);
    if (!existing) throw err;
    return existing;
  }
}

/**
 * Poll the branch's own host until it serves, so 'ready' means usable.
 *
 * Returns false rather than throwing when the budget runs out: the branch DOES
 * exist and is billing, so the command must still report its name and id and
 * must not look like a failed creation.
 */
async function waitUntilServing(
  branch: Branch,
  spinner: ReturnType<typeof clack.spinner> | null,
): Promise<boolean> {
  const baseUrl = buildOssHost(branch.appkey, branch.region);
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    const health = await probeBackendHealth(baseUrl);
    if (health.reachable) return true;
    if (spinner && !announced) {
      spinner.message(`Branch is provisioning its instance (${baseUrl} not answering yet)...`);
      announced = true;
    }
    await new Promise(r => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return false;
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
