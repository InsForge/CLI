/**
 * Builds the human-readable brief shown on the approval page.
 *
 * The CLI makes NO LLM call. Two sources combine, at two trust levels:
 *   1. Hard-rule facts (authoritative) — what the guard detected. The agent
 *      cannot change these. This is the verdict.
 *   2. The calling agent's own brief — its intent, the implications it reasoned
 *      about, and its recommendation to the human. Passed in via
 *      `--reason` / `--impact` / `--recommendation`. The agent is an LLM with the
 *      most context about WHY it's running this; it explains, but it cannot
 *      downgrade the verdict.
 *
 * If the agent supplied no brief, the page falls back to the deterministic rule
 * text and clearly flags that the agent gave no rationale.
 */

import type { OperationContext, RiskAssessment } from './risk-registry.js';
import type { LiveFacts } from './inspect.js';

/** What the calling agent told us about the change (any field may be absent). */
export interface AgentBrief {
  /** Intent: what the operation does and why. */
  reason: string | null;
  /** Implications: who/what is affected, data loss, reversibility. */
  impact: string | null;
  /** The agent's recommendation to the human approver. */
  recommendation: string | null;
}

export interface Brief {
  title: string;
  severity: RiskAssessment['severity'];
  /** Authoritative, rule-derived facts. */
  whatHappens: string;
  blastRadius: string;
  risks: string[];
  /** InsForge's own (rule-derived) guidance to the approver. */
  guidance: string;
  /** The exact command the agent is about to run. */
  command: string;
  /** The calling agent's own brief (intent / implications / recommendation). */
  agent: AgentBrief;
  /** True if the agent supplied any part of its brief. */
  hasAgentBrief: boolean;
  /** True when whatHappens/blastRadius were measured live against the project. */
  tailored: boolean;
  /** Product-side, human-observability read of what this means for users (live). */
  userImpact: string | null;
  /** Why the agent flagged this op as destructive (escalate-only), if it did. */
  agentFlag: string | null;
}

const clean = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

export function buildBrief(
  _ctx: OperationContext,
  risk: RiskAssessment,
  command: string,
  agentInput: AgentBrief,
  live?: LiveFacts | null,
  agentFlag?: string | null,
): Brief {
  const agent: AgentBrief = {
    reason: clean(agentInput.reason),
    impact: clean(agentInput.impact),
    recommendation: clean(agentInput.recommendation),
  };
  return {
    title: risk.title,
    severity: risk.severity,
    // Prefer facts measured live against the project; fall back to generic rule text.
    whatHappens: live?.whatHappens ?? risk.whatHappens,
    blastRadius: live?.blastRadius ?? risk.blastRadius,
    risks: [risk.risk],
    guidance:
      risk.severity === 'critical'
        ? 'Only approve if you intend irreversible data loss and have a backup or are certain.'
        : 'Review the target and scope before approving.',
    command,
    agent,
    hasAgentBrief: Boolean(agent.reason || agent.impact || agent.recommendation),
    tailored: Boolean(live),
    userImpact: live?.userImpact ?? null,
    agentFlag: clean(agentFlag),
  };
}
