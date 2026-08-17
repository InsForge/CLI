import { getBranchApi } from '../../lib/api/platform.js';
import { isTransientApiError } from '../../lib/errors.js';
import type { Branch } from '../../types.js';

/**
 * Read a branch, retrying a bounded number of times on transient failures.
 *
 * Used for the read that decides a poll's FINAL verdict, where a single
 * unlucky 502 is expensive: `branch create` would report a branch that just
 * reached 'ready' as stuck in its last-seen state (and exit non-zero on a
 * genuine success), and `branch reset` would have to give up on confirming an
 * outcome it very nearly had. Inside the poll loop itself this is unnecessary —
 * the loop's own interval already is the retry.
 *
 * A non-transient error is rethrown on the first attempt: it will answer the
 * same way every time. After the last attempt the final transient error is
 * rethrown for the caller to interpret.
 */
export async function readBranchWithRetry(
  branchId: string,
  apiUrl: string | undefined,
  attempts: number,
  delayMs: number,
): Promise<Branch> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getBranchApi(branchId, apiUrl);
    } catch (err) {
      if (!isTransientApiError(err)) throw err;
      lastErr = err;
      if (attempt < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
