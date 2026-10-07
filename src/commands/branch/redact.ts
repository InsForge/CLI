import type { Branch } from '../../types.js';

// Fields the control plane returns on a branch that are credentials, not state.
// Command output ends up in terminal scrollback and CI logs, so they never
// reach stdout. `ai setup` does the same for the gateway key.
const SECRET_FIELDS = ['database_password'];

/** A copy of the branch that is safe to print. */
export function redactBranch(branch: Branch): Branch {
  const safe = { ...branch } as Branch & Record<string, unknown>;
  for (const field of SECRET_FIELDS) delete safe[field];
  return safe;
}
