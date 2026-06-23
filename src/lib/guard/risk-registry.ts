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

const SEV_RANK: Record<Severity, number> = { safe: 0, high: 1, critical: 2 };

/**
 * ALLOWLIST (fail-closed): a statement is `safe` only if we can positively
 * recognize it as a READ or an ADDITIVE write (INSERT/CREATE) with no destructive,
 * privilege, or host-touching keyword. Everything else — DROP of any object,
 * TRUNCATE, DELETE/UPDATE, data-modifying CTEs (`WITH … (DELETE …)`), MERGE,
 * COPY…PROGRAM, GRANT/REVOKE, dynamic SQL, or anything we simply don't recognize
 * — gates by default. This inverts the old denylist: an attacker can't slip a
 * destructive statement through by writing it in a form we didn't enumerate.
 */
function isNonDestructive(s: string): boolean {
  const u = s.toUpperCase();
  // Must START with a read or additive-write verb.
  if (!/^\s*(SELECT|WITH|EXPLAIN|SHOW|TABLE|VALUES|INSERT|CREATE)\b/.test(u)) return false;
  // EXPLAIN ANALYZE actually executes the inner statement.
  if (/^\s*EXPLAIN\b/.test(u) && /\bANALYZE\b/.test(u)) return false;
  // Any destructive / DDL-mutating / privilege / host keyword anywhere → gate.
  if (/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER|GRANT|REVOKE|COPY|MERGE|CALL|DO|VACUUM|REINDEX|CLUSTER|REFRESH|LOCK|REASSIGN|IMPORT|SECURITY|PROGRAM)\b/.test(u)) return false;
  // Locking reads take row locks — not read-only (but harmless on INSERT/CREATE).
  if (/\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/.test(u)) return false;
  // Side-effecting / host-touching functions.
  if (/\b(pg_terminate_backend|pg_cancel_backend|lo_export|lo_import|pg_read_file|pg_ls_dir|pg_write|dblink)\s*\(/i.test(s)) return false;
  return true;
}

const UNCLASSIFIED: RiskAssessment = {
  severity: 'high',
  kind: 'sql.unclassified',
  title: 'Unrecognized statement (not a read)',
  whatHappens: 'This is not a recognized read-only query, so it may modify data, schema, privileges, or run a command on the host.',
  blastRadius: 'Unknown — InsForge could not classify it. Review the exact SQL before approving.',
  risk: 'Anything that is not a plain SELECT/EXPLAIN/SHOW is gated by default (fail-closed).',
};

/** Classify a SINGLE SQL statement. `hasWhere` is scoped to this statement only,
 *  so a WHERE in a sibling statement can't mask an unfiltered DELETE/UPDATE. */
function classifyStatement(stmt: string): RiskAssessment {
  const s = stmt.trim();
  if (!s) return SAFE;
  if (isNonDestructive(s)) return SAFE; // allowlist: reads + additive writes pass
  const upper = s.toUpperCase();
  const hasWhere = /\bWHERE\b/i.test(s);

  // COPY … TO/FROM PROGRAM is arbitrary command execution on the DB host.
  if (/\bCOPY\b/i.test(s) && /\bPROGRAM\b/i.test(s)) {
    return {
      severity: 'critical',
      kind: 'sql.copy_program',
      title: 'Run a shell command on the database host',
      whatHappens: 'COPY … PROGRAM executes an arbitrary OS command as the database server user.',
      blastRadius: 'Full command execution on the database host — not just data loss.',
      risk: 'This is remote code execution. Approve only if you wrote this exact command intentionally.',
    };
  }

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
  // Reached only for statements that are NOT a proven read and didn't match a
  // specific rule above — DDL, privilege changes, unknown verbs, obfuscated SQL.
  // Fail closed: gate it.
  return UNCLASSIFIED;
}

/**
 * Inspect a raw SQL string and classify the MOST dangerous statement in it.
 *
 * Splitting on `;` and classifying each statement independently is what stops a
 * multi-statement bypass: `SELECT 1; DROP TABLE users` must not read as safe just
 * because it starts with SELECT, and `DELETE FROM t; SELECT 1 WHERE x` must not
 * have its unfiltered DELETE masked by the later WHERE. We take the highest
 * severity across all statements. (Naive `;` split can over-trigger on semicolons
 * inside string literals — that errs toward MORE gating, which is safe.)
 */
function classifySql(sql: string): RiskAssessment {
  const statements = sql.split(';').map((p) => p.trim()).filter(Boolean);
  let worst = SAFE;
  for (const st of statements) {
    const r = classifyStatement(st);
    if (SEV_RANK[r.severity] > SEV_RANK[worst.severity]) worst = r;
  }
  return worst;
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

  'projects delete': (ctx) => ({
    severity: 'critical',
    kind: 'project.delete',
    title: 'Delete a project',
    whatHappens: `Permanently deletes project "${(ctx.opts.project as string) ?? '(linked)'}" and all of its resources.`,
    blastRadius: 'The database, storage buckets, edge functions, and every backend resource are destroyed.',
    risk: 'Irreversible. Every app and integration pointing at this project breaks immediately.',
  }),

  'projects restore': () => ({
    severity: 'high',
    kind: 'project.restore',
    title: 'Restore a project',
    whatHappens: 'Brings a paused/deleted project back online, re-provisioning its instance.',
    blastRadius: 'The project transitions state and may incur billing for the restored instance.',
    risk: 'Changes live infrastructure state. Verify you mean to bring this project back.',
  }),

  'projects update-version': () => ({
    severity: 'high',
    kind: 'project.update_version',
    title: 'Update the backend version',
    whatHappens: 'Restarts the project onto the latest InsForge version.',
    blastRadius: 'The instance restarts — brief downtime, and a version change can alter behavior.',
    risk: 'Live traffic is interrupted during the restart. Roll-back means restarting again.',
  }),

  'projects upgrade-instance': (ctx) => ({
    severity: 'high',
    kind: 'project.upgrade_instance',
    title: 'Change instance type',
    whatHappens: `Changes the project instance type to "${ctx.args[0] ?? '?'}", restarting it.`,
    blastRadius: 'Brief downtime during the restart, and the change affects your bill.',
    risk: 'Verify the target instance type — a larger class costs more.',
  }),

  'backups restore': (ctx) => ({
    severity: 'critical',
    kind: 'backup.restore',
    title: 'Restore project from a backup',
    whatHappens: `Overwrites the project's current data with backup "${ctx.args[0] ?? '?'}".`,
    blastRadius: 'The current database and storage are replaced by the backup snapshot.',
    risk: 'Any data written since that backup is lost. Irreversible without another backup.',
  }),

  'backups delete': (ctx) => ({
    severity: 'high',
    kind: 'backup.delete',
    title: 'Delete a backup',
    whatHappens: `Removes backup "${ctx.args[0] ?? '?'}".`,
    blastRadius: 'That restore point is gone.',
    risk: 'You can no longer restore the project to this snapshot.',
  }),

  'orgs members remove': (ctx) => ({
    severity: 'high',
    kind: 'org.member_remove',
    title: 'Remove an organization member',
    whatHappens: `Removes member "${ctx.args[0] ?? '?'}" from the organization.`,
    blastRadius: 'That user loses access to all projects in the organization.',
    risk: 'They must be re-invited to regain access.',
  }),

  'secrets rotate': (ctx) => ({
    severity: 'high',
    kind: 'secrets.rotate',
    title: 'Rotate a project key',
    whatHappens: `Rotates the ${ctx.args[0] ?? 'key'} — the old value stops working after the grace period.`,
    blastRadius: 'Clients still using the old key fail once the grace period ends.',
    risk: 'Update every consumer of the old key before the grace window closes.',
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
