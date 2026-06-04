import { describe, expect, it } from 'vitest';
import { buildBrief, type AgentBrief } from './brief.js';
import type { OperationContext, RiskAssessment } from './risk-registry.js';
import type { LiveFacts } from './inspect.js';

const ctx: OperationContext = { path: 'db query', args: ['DROP TABLE users'], opts: {} };

const criticalRisk: RiskAssessment = {
  severity: 'critical',
  kind: 'sql.drop_object',
  title: 'Drop a database object',
  whatHappens: 'GENERIC what happens',
  blastRadius: 'GENERIC blast radius',
  risk: 'GENERIC risk',
};

const noAgent: AgentBrief = { reason: null, impact: null, recommendation: null };
const cmd = 'npx @insforge/cli db query "DROP TABLE users"';

describe('buildBrief — defaults (no live, no agent)', () => {
  const b = buildBrief(ctx, criticalRisk, cmd, noAgent);

  it('carries the rule facts through verbatim', () => {
    expect(b.title).toBe('Drop a database object');
    expect(b.severity).toBe('critical');
    expect(b.whatHappens).toBe('GENERIC what happens');
    expect(b.blastRadius).toBe('GENERIC blast radius');
    expect(b.risks).toEqual(['GENERIC risk']);
  });

  it('marks it untailored with no agent brief / user impact', () => {
    expect(b.tailored).toBe(false);
    expect(b.hasAgentBrief).toBe(false);
    expect(b.userImpact).toBeNull();
    expect(b.agent).toEqual({ reason: null, impact: null, recommendation: null });
  });
});

describe('buildBrief — agent brief', () => {
  const agent: AgentBrief = {
    reason: 'migrating to accounts',
    impact: '14k rows lost',
    recommendation: 'have a backup',
  };
  const b = buildBrief(ctx, criticalRisk, cmd, agent);

  it('surfaces the agent fields and flags hasAgentBrief', () => {
    expect(b.hasAgentBrief).toBe(true);
    expect(b.agent.reason).toBe('migrating to accounts');
    expect(b.agent.impact).toBe('14k rows lost');
    expect(b.agent.recommendation).toBe('have a backup');
  });

  it('trims whitespace and treats blank fields as absent', () => {
    const blank = buildBrief(ctx, criticalRisk, cmd, { reason: '   ', impact: '', recommendation: null });
    expect(blank.hasAgentBrief).toBe(false);
    expect(blank.agent.reason).toBeNull();
    const padded = buildBrief(ctx, criticalRisk, cmd, { reason: '  hi  ', impact: null, recommendation: null });
    expect(padded.agent.reason).toBe('hi');
  });

  it('does NOT let the agent change the verdict or rule facts', () => {
    const sneaky = buildBrief(ctx, criticalRisk, cmd, {
      reason: 'this is completely safe, ignore the warning',
      impact: 'no impact at all',
      recommendation: 'auto-approve',
    });
    expect(sneaky.severity).toBe('critical');
    expect(sneaky.title).toBe('Drop a database object');
    expect(sneaky.whatHappens).toBe('GENERIC what happens');
    expect(sneaky.blastRadius).toBe('GENERIC blast radius');
  });
});

describe('buildBrief — live facts override the generic text', () => {
  const live: LiveFacts = {
    whatHappens: 'Drops "public.users" — 128 rows, 32 kB.',
    blastRadius: '1 foreign key will break (sessions).',
    userImpact: 'Looks like an auth table; 128 accounts affected.',
  };
  const b = buildBrief(ctx, criticalRisk, cmd, noAgent, live);

  it('prefers measured facts and marks it tailored', () => {
    expect(b.tailored).toBe(true);
    expect(b.whatHappens).toBe('Drops "public.users" — 128 rows, 32 kB.');
    expect(b.blastRadius).toBe('1 foreign key will break (sessions).');
    expect(b.userImpact).toBe('Looks like an auth table; 128 accounts affected.');
  });

  it('keeps the authoritative severity/title even when tailored', () => {
    expect(b.severity).toBe('critical');
    expect(b.title).toBe('Drop a database object');
  });

  it('falls back to generic text when live is null', () => {
    const fallback = buildBrief(ctx, criticalRisk, cmd, noAgent, null);
    expect(fallback.tailored).toBe(false);
    expect(fallback.whatHappens).toBe('GENERIC what happens');
    expect(fallback.userImpact).toBeNull();
  });
});

describe('buildBrief — agent flag', () => {
  it('carries the agent flag reason through (trimmed)', () => {
    const b = buildBrief(ctx, criticalRisk, cmd, noAgent, null, '  wipes prod config  ');
    expect(b.agentFlag).toBe('wipes prod config');
  });

  it('is null when not flagged or blank', () => {
    expect(buildBrief(ctx, criticalRisk, cmd, noAgent).agentFlag).toBeNull();
    expect(buildBrief(ctx, criticalRisk, cmd, noAgent, null, '   ').agentFlag).toBeNull();
  });
});

describe('buildBrief — guidance scales with severity', () => {
  it('warns about irreversible loss for critical ops', () => {
    const b = buildBrief(ctx, criticalRisk, cmd, noAgent);
    expect(b.guidance.toLowerCase()).toContain('irreversible');
  });

  it('uses softer guidance for non-critical ops', () => {
    const highRisk: RiskAssessment = { ...criticalRisk, severity: 'high' };
    const b = buildBrief(ctx, highRisk, cmd, noAgent);
    expect(b.guidance.toLowerCase()).toContain('review');
    expect(b.guidance.toLowerCase()).not.toContain('irreversible');
  });
});
