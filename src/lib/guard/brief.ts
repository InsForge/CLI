/**
 * Builds the human-readable brief shown on the approval page.
 *
 * The CLI makes NO LLM call. Two sources combine:
 *   1. Hard-rule facts (authoritative) — what the guard detected. The agent
 *      cannot change these.
 *   2. The calling agent's own explanation of the change and its implications,
 *      passed in via `--reason` / INSFORGE_GUARD_SUMMARY. The agent is an LLM
 *      with the most context about WHY it's running this; it explains, but it
 *      cannot downgrade the verdict.
 *
 * If the agent supplied no explanation, the page falls back to the deterministic
 * rule text and clearly flags that the agent gave no rationale.
 */

import type { OperationContext, RiskAssessment } from './risk-registry.js';

export interface Brief {
  title: string;
  severity: RiskAssessment['severity'];
  /** Authoritative, rule-derived facts. */
  whatHappens: string;
  blastRadius: string;
  risks: string[];
  recommendation: string;
  /** The exact command the agent is about to run. */
  command: string;
  /** The calling agent's own summary of the change + implications, if provided. */
  agentSummary: string | null;
}

export function buildBrief(
  ctx: OperationContext,
  risk: RiskAssessment,
  command: string,
  agentSummary: string | null,
): Brief {
  return {
    title: risk.title,
    severity: risk.severity,
    whatHappens: risk.whatHappens,
    blastRadius: risk.blastRadius,
    risks: [risk.risk],
    recommendation:
      risk.severity === 'critical'
        ? 'Only approve if you intend irreversible data loss and have a backup or are certain.'
        : 'Review the target and scope before approving.',
    command,
    agentSummary: agentSummary?.trim() ? agentSummary.trim() : null,
  };
}
