/**
 * Declarative risk classification for the human-in-the-loop guard.
 *
 * The guard runs as a `preAction` stage in the CLI dispatch pipeline, so it
 * works for EVERY caller — Claude Code, Cursor, a shell script, or a human.
 * Classification is declarative (a property of the command), and for commands
 * that carry a freeform payload (e.g. `db query <sql>`) we additionally inspect
 * the REAL operation params rather than regex-matching the raw argv.
 */

export type Severity = 'safe' | 'high' | 'critical';

export interface OperationContext {
  /** Space-joined command path, e.g. "db query" or "compute delete". */
  path: string;
  /** Positional args passed to the command's action. */
  args: string[];
  /** Parsed options for the command. */
  opts: Record<string, unknown>;
}

export interface RiskAssessment {
  severity: Severity;
  /** Short machine id for the operation kind, e.g. "sql.drop_table". */
  kind: string;
  /** One-line label shown as the card title. */
  title: string;
  /** Deterministic, no-LLM-needed description of what will happen. */
  whatHappens: string;
  /** Deterministic blast-radius note. */
  blastRadius: string;
  /** Deterministic risk note. */
  risk: string;
}

const SAFE: RiskAssessment = {
  severity: 'safe',
  kind: 'safe',
  title: 'Safe operation',
  whatHappens: '',
  blastRadius: '',
  risk: '',
};

/** Verbs that are destructive by default — defense-in-depth catch-all. */
const DESTRUCTIVE_VERBS = ['delete', 'destroy', 'remove', 'drop', 'purge', 'wipe'];

/**
 * Inspect a raw SQL string and classify the most dangerous statement in it.
 * This looks at the actual operation, not the command path.
 */
function classifySql(sql: string): RiskAssessment {
  const s = sql.trim();
  const upper = s.toUpperCase();
  const hasWhere = /\bWHERE\b/i.test(s);

  if (/\bDROP\s+(TABLE|SCHEMA|DATABASE|TYPE|VIEW|MATERIALIZED\s+VIEW)\b/i.test(s)) {
    return {
      severity: 'critical',
      kind: 'sql.drop_object',
      title: 'Drop a database object',
      whatHappens: 'Permanently removes a table/schema/view and everything in it.',
      blastRadius: 'All rows, indexes, constraints, and dependent objects are destroyed.',
      risk: 'Irreversible without a backup. Application code referencing it will break.',
    };
  }
  if (/\bTRUNCATE\b/i.test(s)) {
    return {
      severity: 'critical',
      kind: 'sql.truncate',
      title: 'Truncate a table',
      whatHappens: 'Deletes every row in the target table(s) immediately.',
      blastRadius: 'Entire table contents; cannot be rolled back outside a transaction.',
      risk: 'Total data loss for the affected tables. Often not WAL-logged per-row.',
    };
  }
  if (/^\s*DELETE\b/i.test(s) && !hasWhere) {
    return {
      severity: 'critical',
      kind: 'sql.delete_all',
      title: 'DELETE without a WHERE clause',
      whatHappens: 'Deletes ALL rows in the target table — there is no filter.',
      blastRadius: 'Every row in the table.',
      risk: 'This is almost always a mistake. Add a WHERE clause unless you truly mean all rows.',
    };
  }
  if (/^\s*UPDATE\b/i.test(s) && !hasWhere) {
    return {
      severity: 'critical',
      kind: 'sql.update_all',
      title: 'UPDATE without a WHERE clause',
      whatHappens: 'Rewrites the targeted column(s) for ALL rows in the table.',
      blastRadius: 'Every row in the table.',
      risk: 'Almost always unintended. Add a WHERE clause to scope the change.',
    };
  }
  if (/\bALTER\s+TABLE\b.*\bDROP\b/i.test(s)) {
    return {
      severity: 'high',
      kind: 'sql.alter_drop',
      title: 'Drop a column or constraint',
      whatHappens: 'Removes a column/constraint from an existing table.',
      blastRadius: 'Data in the dropped column is lost; dependent code/queries may break.',
      risk: 'Irreversible data loss for the dropped column.',
    };
  }
  if (/\b(DROP\s+POLICY|ALTER\s+POLICY|DISABLE\s+ROW\s+LEVEL\s+SECURITY)\b/i.test(s)) {
    return {
      severity: 'high',
      kind: 'sql.rls_change',
      title: 'Change row-level security',
      whatHappens: 'Modifies or removes a row-level security policy.',
      blastRadius: 'Tenant isolation / access control for the table changes immediately.',
      risk: 'Loosening RLS can expose other tenants’ data. Verify the policy intent.',
    };
  }
  if (/^\s*DELETE\b/i.test(s) || /^\s*UPDATE\b/i.test(s)) {
    return {
      severity: 'high',
      kind: 'sql.mutation',
      title: upper.startsWith('DELETE') ? 'DELETE rows' : 'UPDATE rows',
      whatHappens: 'Mutates existing rows matching the WHERE clause.',
      blastRadius: 'Rows matching the filter — verify the filter is correct.',
      risk: 'Mutations are hard to undo without a backup.',
    };
  }
  // SELECT / INSERT / CREATE / etc. — not destructive.
  return SAFE;
}

/** Explicit, declarative descriptors keyed by command path. */
const REGISTRY: Record<string, (ctx: OperationContext) => RiskAssessment> = {
  'db query': (ctx) => classifySql(String(ctx.args[0] ?? '')),

  'compute delete': (ctx) => ({
    severity: 'critical',
    kind: 'compute.delete',
    title: 'Delete a compute service',
    whatHappens: `Deletes compute service "${ctx.args[0] ?? '?'}" and its Fly.io resources.`,
    blastRadius: 'The running service, its machines, and attached resources are destroyed.',
    risk: 'Live traffic to this service stops immediately. Not recoverable.',
  }),

  'storage delete-bucket': (ctx) => ({
    severity: 'critical',
    kind: 'storage.delete_bucket',
    title: 'Delete a storage bucket',
    whatHappens: `Deletes bucket "${ctx.args[0] ?? '?'}" and all objects inside it.`,
    blastRadius: 'Every file in the bucket and any public URLs pointing at them.',
    risk: 'Irreversible. Apps serving these files will 404.',
  }),

  'functions delete': (ctx) => ({
    severity: 'high',
    kind: 'functions.delete',
    title: 'Delete an edge function',
    whatHappens: `Removes edge function "${ctx.args[0] ?? '?'}".`,
    blastRadius: 'Any client or webhook invoking this function starts failing.',
    risk: 'Callers get errors until redeployed.',
  }),

  'secrets delete': (ctx) => ({
    severity: 'high',
    kind: 'secrets.delete',
    title: 'Delete a secret',
    whatHappens: `Removes secret "${ctx.args[0] ?? '?'}".`,
    blastRadius: 'Functions/services reading this secret lose access at next run.',
    risk: 'Can break running workloads that depend on the value.',
  }),
};

/**
 * Classify an operation. Returns a `safe` assessment when nothing dangerous
 * is detected — the guard does NOT interrupt safe operations.
 */
export function assess(ctx: OperationContext): RiskAssessment {
  const explicit = REGISTRY[ctx.path];
  if (explicit) return explicit(ctx);

  // Defense-in-depth: any unregistered command whose last segment is a
  // destructive verb is treated as high severity by default.
  const verb = ctx.path.split(' ').pop() ?? '';
  if (DESTRUCTIVE_VERBS.includes(verb)) {
    return {
      severity: 'high',
      kind: `generic.${verb}`,
      title: `Destructive operation: ${ctx.path}`,
      whatHappens: `Runs "${ctx.path}" which is a destructive operation.`,
      blastRadius: 'The targeted resource is removed or overwritten.',
      risk: 'May be irreversible. Review before approving.',
    };
  }

  return SAFE;
}

/**
 * Layer the calling agent's own judgment on top of the static rules.
 *
 * ESCALATE-ONLY by construction: a flag can raise a `safe` verdict to `high` (so
 * the agent can stop itself on an edge case the rules don't recognize), but it
 * can NEVER lower a verdict the rules already produced. A buggy or prompt-injected
 * agent therefore cannot use this to skip the gate — only to add one.
 */
export function applyAgentFlag(risk: RiskAssessment, flagged: boolean): RiskAssessment {
  if (!flagged || risk.severity !== 'safe') return risk;
  return {
    severity: 'high',
    kind: 'agent.flagged',
    title: 'Agent-flagged operation',
    whatHappens: 'The calling agent flagged this operation as potentially destructive.',
    blastRadius: 'Not classified by InsForge’s hard rules — review the command and the agent’s reason.',
    risk: 'Flagged by the agent for human review.',
  };
}
