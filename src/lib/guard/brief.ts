/**
 * Produces the human-readable brief shown on the approval page.
 *
 * Tries the locally-installed `claude` CLI (`claude -p`) to generate a richer,
 * context-aware explanation — no API key wiring needed. Falls back to a
 * deterministic brief built from the risk assessment if the LLM is unavailable,
 * not installed, or slow. The guard NEVER blocks on the LLM.
 */

import { spawn } from 'node:child_process';
import type { OperationContext, RiskAssessment } from './risk-registry.js';

export interface Brief {
  title: string;
  severity: RiskAssessment['severity'];
  whatHappens: string;
  blastRadius: string;
  risks: string[];
  recommendation: string;
  /** What the operation appears to be trying to accomplish. */
  intent: string;
  /** The exact command the agent is about to run. */
  command: string;
  /** True when the LLM enriched this brief; false for the deterministic path. */
  enriched: boolean;
}

function deterministic(ctx: OperationContext, risk: RiskAssessment, command: string): Brief {
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
    intent: `Agent invoked \`insforge ${ctx.path}\`.`,
    command,
    enriched: false,
  };
}

const LLM_TIMEOUT_MS = 12_000;

function runClaude(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn('claude', ['-p', prompt], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      done(null);
    }, LLM_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { out += String(d); });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 && out.trim() ? out.trim() : null);
    });
  });
}

function parseLlm(raw: string): Partial<Brief> | null {
  // The model is asked for strict JSON; tolerate code fences.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      whatHappens: typeof obj.whatHappens === 'string' ? obj.whatHappens : undefined,
      blastRadius: typeof obj.blastRadius === 'string' ? obj.blastRadius : undefined,
      risks: Array.isArray(obj.risks) ? obj.risks.map(String) : undefined,
      recommendation: typeof obj.recommendation === 'string' ? obj.recommendation : undefined,
      intent: typeof obj.intent === 'string' ? obj.intent : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Build the brief. Always resolves — never throws, never hangs.
 * Set INSFORGE_GUARD_NO_LLM=1 to force the deterministic path.
 */
export async function buildBrief(
  ctx: OperationContext,
  risk: RiskAssessment,
  command: string,
): Promise<Brief> {
  const base = deterministic(ctx, risk, command);
  if (process.env.INSFORGE_GUARD_NO_LLM === '1') return base;

  const prompt = [
    'You are a safety reviewer for the InsForge CLI. An automated agent is about to run a',
    'potentially destructive command. Explain it to a human approver in plain language.',
    '',
    `Command: insforge ${ctx.path} ${ctx.args.join(' ')}`.trim(),
    `Detected risk: ${risk.kind} (${risk.severity})`,
    '',
    'Respond with STRICT JSON only, no prose, with these keys:',
    '{"whatHappens": string, "blastRadius": string, "risks": string[], "recommendation": string, "intent": string}',
    '- whatHappens: one or two sentences, concrete.',
    '- blastRadius: what data/services are affected.',
    '- risks: 2-4 short bullet strings.',
    '- recommendation: approve/deny guidance for the human.',
    '- intent: your best guess at what the agent was trying to accomplish.',
  ].join('\n');

  const raw = await runClaude(prompt);
  if (!raw) return base;
  const parsed = parseLlm(raw);
  if (!parsed) return base;

  return {
    ...base,
    whatHappens: parsed.whatHappens ?? base.whatHappens,
    blastRadius: parsed.blastRadius ?? base.blastRadius,
    risks: parsed.risks?.length ? parsed.risks : base.risks,
    recommendation: parsed.recommendation ?? base.recommendation,
    intent: parsed.intent ?? base.intent,
    enriched: true,
  };
}
