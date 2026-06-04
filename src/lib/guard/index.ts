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
import { assess, applyAgentFlag, type OperationContext, type RiskAssessment } from './risk-registry.js';
import { buildBrief, type AgentBrief } from './brief.js';
import { getProjectConfig } from '../config.js';
import { guardEnabled } from './enabled.js';
import { inspectSqlTarget } from './inspect.js';
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
 * Whether to require an agent brief before showing the approval page.
 *  - INSFORGE_GUARD_REQUIRE_BRIEF=1 → always require (even for a human at a TTY)
 *  - INSFORGE_GUARD_REQUIRE_BRIEF=0 → never require (go straight to the page)
 *  - unset → require for non-interactive callers (agents, CI), not for humans.
 * The point is to make the calling agent reason about the change and present its
 * intent readably, rather than silently bouncing the human a bare command.
 */
function shouldRequireBrief(): boolean {
  const env = process.env.INSFORGE_GUARD_REQUIRE_BRIEF;
  if (env === '1') return true;
  if (env === '0') return false;
  return !process.stdout.isTTY;
}

/**
 * A copy-paste-ready instruction telling the calling agent to reason about the
 * implications and re-run WITH a human-readable brief. This is the "encourage
 * the local LLM" path: the CLI doesn't write the explanation, it makes the agent
 * produce one. The hard-rule STOP still applies on the re-run.
 */
function renderNudge(command: string, risk: RiskAssessment): string {
  const sub = command.replace(/^npx @insforge\/cli\s*/, '');
  return [
    '',
    '  🛑 InsForge guard — destructive operation detected (NOT run):',
    `       ${command}`,
    `       [${risk.severity} · ${risk.kind}] ${risk.title}`,
    '',
    "  A human must approve this. Before they're asked, explain your intent so they",
    "  can decide quickly — and so you've reasoned about the implications first.",
    '',
    '  Re-run the SAME command with a human-readable brief:',
    '',
    '    npx @insforge/cli \\',
    '      --reason         "what this does and why" \\',
    '      --impact         "who/what is affected · data loss · reversibility" \\',
    '      --recommendation "your recommendation to the approver" \\',
    `      ${sub}`,
    '',
    '  The hard-rule STOP still applies on the next run — the brief explains the',
    '  operation for the human, it does not bypass approval.',
    '',
    '',
  ].join('\n');
}

/**
 * The guard hook. Register with:
 *   program.hook('preAction', guardHook)
 * Commander awaits async preAction hooks (requires parseAsync), so this can
 * block on the approval page before the command's action runs.
 */
export async function guardHook(thisCommand: Command, actionCommand: Command): Promise<void> {
  // Rollout switch: disabled by default so shipping is a no-op until opted in.
  // Precedence: INSFORGE_GUARD env > persisted `link --guard` setting > default.
  let storedGuard: boolean | null = null;
  try { storedGuard = getProjectConfig()?.guard ?? null; } catch { /* fail to default */ }
  if (!guardEnabled(process.env, storedGuard)) return;

  const path = commandPath(actionCommand);
  const args = (actionCommand.processedArgs ?? []).map((a) => (Array.isArray(a) ? a.join(' ') : String(a ?? '')));
  const opts = actionCommand.opts() as Record<string, unknown>;
  const ctx: OperationContext = { path, args, opts };

  const risk = assess(ctx);

  // The calling agent may flag an edge case the static rules miss. This is
  // ESCALATE-ONLY: `--flag-destructive [reason]` can raise a 'safe' verdict to
  // require human approval, but it can NEVER lower the rule verdict. A buggy or
  // injected agent cannot use it to skip the gate — only to add one.
  const flagRaw = thisCommand.opts().flagDestructive as string | boolean | undefined;
  const agentFlagged = flagRaw !== undefined && flagRaw !== false;
  const agentFlag = typeof flagRaw === 'string' && flagRaw.trim() ? flagRaw.trim() : null;

  const effective = applyAgentFlag(risk, agentFlagged);
  if (effective.severity === 'safe') return; // not dangerous, and not agent-flagged

  // Quote args containing whitespace so the displayed/echoed command is paste-ready.
  // Use the canonical public invocation (matches how agents/docs call the CLI).
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  const command = `npx @insforge/cli ${path} ${quoted.join(' ')}`.trim();
  const base = { ts: new Date().toISOString(), path, command, kind: effective.kind, severity: effective.severity };

  // Explicit, audited bypass for automation that has opted in.
  if (process.env.INSFORGE_GUARD_BYPASS === '1') {
    audit({ ...base, decision: 'bypassed' });
    process.stderr.write('  ⚠️  Guard bypassed via INSFORGE_GUARD_BYPASS (audited).\n');
    return;
  }

  // The calling agent's own brief — intent, implications, recommendation. The
  // CLI makes no LLM call of its own: the agent is the LLM with the most context
  // about WHY it's running this. It can explain, but it cannot downgrade the rule
  // verdict. Flags take precedence over env fallbacks.
  const gopts = thisCommand.opts();
  const agent: AgentBrief = {
    reason: (gopts.reason as string | undefined) ?? process.env.INSFORGE_GUARD_SUMMARY ?? null,
    impact: (gopts.impact as string | undefined) ?? process.env.INSFORGE_GUARD_IMPACT ?? null,
    recommendation:
      (gopts.recommendation as string | undefined) ?? process.env.INSFORGE_GUARD_RECOMMENDATION ?? null,
  };

  // Encourage the local LLM to articulate intent: if no explanation was given
  // and the caller is non-interactive (an agent/CI), don't pop the page — return
  // an instruction telling the agent to reason about the implications and re-run
  // WITH a brief. A human at a TTY proceeds straight to the page instead.
  // An agent flag reason already articulates intent, so it also satisfies the nudge.
  const hasReason = Boolean((agent.reason && agent.reason.trim()) || agentFlag);
  if (!hasReason && shouldRequireBrief()) {
    process.stderr.write(renderNudge(command, effective));
    audit({ ...base, decision: 'needs_brief' });
    process.exit(2);
  }

  // Tailor the authoritative facts to the real project by inspecting it live
  // (read-only, fail-open: null → generic rule text; never changes the verdict).
  let live = null;
  if (path === 'db query' && typeof args[0] === 'string') {
    live = await inspectSqlTarget(args[0]);
  }

  const brief = buildBrief(ctx, effective, command, agent, live, agentFlag);

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
