/**
 * Human-in-the-loop guard — a `preAction` stage in the CLI dispatch pipeline.
 *
 * Because it lives inside the `insforge` binary itself (not in any agent's
 * harness), it protects EVERY caller automatically: Claude Code, Cursor, a
 * shell script, CI, or a human. Dangerous operations stop, a human-readable
 * brief is shown on a localhost page, and the command only runs if a human
 * approves. Fail-closed throughout.
 */

import type { Command } from 'commander';
import { assess, type OperationContext } from './risk-registry.js';
import { buildBrief } from './brief.js';
import { requestApproval } from './approval-server.js';
import { audit } from './audit.js';

/** Walk up the Commander tree to build the space-joined command path. */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let node: Command | null = cmd;
  while (node && node.parent) {
    parts.unshift(node.name());
    node = node.parent;
  }
  return parts.join(' ');
}

/**
 * The guard hook. Register with:
 *   program.hook('preAction', guardHook)
 * Commander awaits async preAction hooks (requires parseAsync), so this can
 * block on the approval page before the command's action runs.
 */
export async function guardHook(_thisCommand: Command, actionCommand: Command): Promise<void> {
  const path = commandPath(actionCommand);
  const args = (actionCommand.processedArgs ?? []).map((a) => (Array.isArray(a) ? a.join(' ') : String(a ?? '')));
  const opts = actionCommand.opts() as Record<string, unknown>;
  const ctx: OperationContext = { path, args, opts };

  const risk = assess(ctx);
  if (risk.severity === 'safe') return; // never interrupt safe operations

  const command = `insforge ${path} ${args.join(' ')}`.trim();
  const base = { ts: new Date().toISOString(), path, command, kind: risk.kind, severity: risk.severity };

  // Explicit, audited bypass for automation that has opted in.
  if (process.env.INSFORGE_GUARD_BYPASS === '1') {
    audit({ ...base, decision: 'bypassed' });
    process.stderr.write('  ⚠️  Guard bypassed via INSFORGE_GUARD_BYPASS (audited).\n');
    return;
  }

  let brief;
  try {
    brief = await buildBrief(ctx, risk, command);
  } catch {
    // If we cannot even build a brief, fail closed.
    audit({ ...base, decision: 'failed' });
    process.stderr.write('  🛑 Guard could not render the operation for review — denied.\n');
    process.exit(1);
  }

  const result = await requestApproval(brief);
  audit({ ...base, decision: result });

  if (result === 'approved') {
    process.stderr.write('  ✅ Approved by human — proceeding.\n');
    return; // let the command's action run
  }

  const reason = result === 'timeout' ? 'No response within the approval window' : 'Denied by human';
  process.stderr.write(`  🛑 ${reason} — command not run.\n`);
  process.exit(1);
}
