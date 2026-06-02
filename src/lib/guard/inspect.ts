/**
 * Live, read-only introspection of the linked project so the approval page
 * states facts about the ACTUAL target — real row count, size, and the real
 * dependents (foreign keys / views / RLS policies) that will break — instead of
 * generic boilerplate.
 *
 * Trust note: these facts are measured by InsForge against the project's own
 * database (via the same `runRawSql` path `db query` uses), NOT supplied by the
 * agent. They enrich the authoritative side of the page.
 *
 * Fail-open: any parse failure, query error, or timeout returns `null` and the
 * caller falls back to the generic rule text. Introspection NEVER changes the
 * stop/allow verdict and NEVER blocks the guard — only the SELECTs here read the
 * DB, and they are wrapped in a hard timeout.
 */

import { runRawSql } from '../api/oss.js';

export interface LiveFacts {
  /** Concrete, project-specific replacement for the generic "what will happen". */
  whatHappens: string;
  /** Concrete, project-specific replacement for the generic "blast radius". */
  blastRadius: string;
  /**
   * Product-side, human-observability read: what this means for the people using
   * the app. Grounded in measured signals (scale + live read/write activity)
   * plus a clearly-hedged data-category guess. Null when not derivable.
   */
  userImpact: string | null;
}

/** A hedged, name-based guess at what kind of user data a table holds. */
function categorize(schema: string, table: string): string | null {
  const t = table.toLowerCase();
  if (schema === 'auth' || /(^|_)(users?|accounts?|profiles?|sessions?|identities|credentials)(_|$)/.test(t)) {
    return 'looks like an authentication / account table — dropping it can sign users out or destroy their accounts';
  }
  if (/(stripe|subscription|invoice|payment|customer|billing|charge|price|order)/.test(t)) {
    return 'looks like billing / commerce data — subscriptions, invoices, or order history for real customers may be lost';
  }
  if (/(message|post|comment|chat|thread|note|document|file|photo|media|upload)/.test(t)) {
    return 'looks like user-generated content — people may lose things they created';
  }
  return null;
}

/** Turn measured signals into a human-observability sentence. */
function buildUserImpact(
  schema: string,
  table: string,
  rows: number | null,
  policies: number,
  reads: number | null,
  writes: number | null,
): string {
  const parts: string[] = [];
  const cat = categorize(schema, table);
  if (cat) parts.push(`This ${cat}.`);

  if (rows !== null) {
    const scoped = policies > 0 ? ' (row-level security suggests this is per-user data)' : '';
    parts.push(`~${rows.toLocaleString()} record${rows === 1 ? '' : 's'} are affected${scoped}.`);
  }

  // Live observability: is it actually being used right now?
  if (reads !== null || writes !== null) {
    const r = reads ?? 0;
    const w = writes ?? 0;
    if (r + w > 0) {
      parts.push(`It is in active use — ${r.toLocaleString()} read${r === 1 ? '' : 's'} and ${w.toLocaleString()} write${w === 1 ? '' : 's'} recorded since stats were last reset, so live users likely depend on it.`);
    } else {
      parts.push('No reads or writes are recorded for it — it may be dormant, but verify before trusting that.');
    }
  }

  return parts.join(' ').trim();
}

/** A table reference parsed out of a destructive statement. */
interface Target {
  schema: string;
  table: string;
  op: 'drop' | 'truncate' | 'delete' | 'update';
}

const IDENT = '"?([A-Za-z_][A-Za-z0-9_]*)"?';
const QUALIFIED = `(?:${IDENT}\\.)?${IDENT}`;

/** Parse the target table from a destructive SQL statement. Returns null if we
 *  can't confidently identify a single table (then we fall back to generic). */
function parseTarget(sql: string): Target | null {
  const s = sql.trim();
  const grab = (m: RegExpMatchArray | null): Omit<Target, 'op'> | null => {
    if (!m) return null;
    // groups: 1=schema(optional) 2=table  (from QUALIFIED)
    const schema = (m[1] ?? 'public').toLowerCase();
    const table = (m[2] ?? '').toLowerCase();
    return table ? { schema, table } : null;
  };

  let m: RegExpMatchArray | null;
  if ((m = s.match(new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, 'i')))) {
    const t = grab(m); return t && { ...t, op: 'drop' };
  }
  if ((m = s.match(new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?${QUALIFIED}`, 'i')))) {
    const t = grab(m); return t && { ...t, op: 'truncate' };
  }
  if ((m = s.match(new RegExp(`^DELETE\\s+FROM\\s+${QUALIFIED}`, 'i')))) {
    const t = grab(m); return t && { ...t, op: 'delete' };
  }
  if ((m = s.match(new RegExp(`^UPDATE\\s+${QUALIFIED}`, 'i')))) {
    const t = grab(m); return t && { ...t, op: 'update' };
  }
  return null;
}

/** Run one introspection query; resolve [] on any error (fail-open). */
async function q(sql: string): Promise<Record<string, unknown>[]> {
  try {
    const { rows } = await runRawSql(sql);
    return rows ?? [];
  } catch {
    return [];
  }
}

function prettyBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
};

const TIMEOUT_MS = 5_000;

/**
 * Inspect the target of a destructive SQL statement against the live project.
 * Returns concrete facts, or null to fall back to the generic rule text.
 */
export async function inspectSqlTarget(sql: string): Promise<LiveFacts | null> {
  const target = parseTarget(sql);
  if (!target) return null;

  const work = (async (): Promise<LiveFacts | null> => {
    const { schema, table, op } = target;
    const fq = `${schema}.${table}`;
    const lit = `'${schema}'`;
    const tlit = `'${table}'`;

    // 1) Does it exist? (+ size). Ordinary/partitioned tables only.
    const existRows = await q(
      `SELECT c.oid::bigint AS oid, pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${lit} AND c.relname = ${tlit} AND c.relkind IN ('r','p')`,
    );
    if (existRows.length === 0) {
      if (op === 'drop') {
        return {
          whatHappens: `Table "${fq}" was not found in this project — the statement will error (or no-op with IF EXISTS). Nothing is dropped.`,
          blastRadius: 'No matching table, so no rows or dependents are affected.',
          userImpact: 'No effect on users — there is nothing here to remove.',
        };
      }
      return null; // can't enrich a missing target for truncate/delete/update; use generic
    }
    const bytes = num(existRows[0].bytes);

    // 2) row count, 3) incoming FKs, 4) RLS policies, 5) dependent views,
    // 6) live read/write activity (observability) — in parallel.
    const [countRows, fkRows, polRows, viewRows, statRows] = await Promise.all([
      q(`SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`),
      q(`SELECT conrelid::regclass::text AS t FROM pg_constraint
         WHERE confrelid = '"${schema}"."${table}"'::regclass AND contype = 'f'`),
      q(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = ${lit} AND tablename = ${tlit}`),
      q(`SELECT DISTINCT view_name FROM information_schema.view_table_usage
         WHERE table_schema = ${lit} AND table_name = ${tlit}`),
      q(`SELECT coalesce(seq_scan,0)+coalesce(idx_scan,0) AS reads,
                coalesce(n_tup_ins,0)+coalesce(n_tup_upd,0)+coalesce(n_tup_del,0) AS writes
         FROM pg_stat_user_tables WHERE schemaname = ${lit} AND relname = ${tlit}`),
    ]);

    const rows = countRows.length ? num(countRows[0].n) : null;
    const fks = fkRows.map((r) => String(r.t)).filter((t) => t && t !== fq);
    const policies = polRows.length ? num(polRows[0].n) : 0;
    const views = viewRows.map((r) => String(r.view_name)).filter(Boolean);
    const reads = statRows.length ? num(statRows[0].reads) : null;
    const writes = statRows.length ? num(statRows[0].writes) : null;
    const userImpact = buildUserImpact(schema, table, rows, policies, reads, writes) || null;

    const rowsTxt = rows === null ? 'an unknown number of' : rows.toLocaleString();
    const sizeTxt = prettyBytes(bytes);

    // Build the blast-radius sentence from real dependents.
    const deps: string[] = [];
    if (fks.length) deps.push(`${fks.length} foreign key${fks.length > 1 ? 's' : ''} will break (${fks.slice(0, 5).join(', ')}${fks.length > 5 ? ', …' : ''})`);
    if (views.length) deps.push(`${views.length} dependent view${views.length > 1 ? 's' : ''} (${views.slice(0, 5).join(', ')}${views.length > 5 ? ', …' : ''})`);
    if (policies) deps.push(`${policies} RLS polic${policies > 1 ? 'ies' : 'y'} removed`);
    const depsTxt = deps.length ? deps.join('; ') + '.' : 'Nothing else references this table (no foreign keys or views detected).';

    if (op === 'drop') {
      return {
        whatHappens: `Drops "${fq}" — ${rowsTxt} row${rows === 1 ? '' : 's'}, ${sizeTxt}.`,
        blastRadius: depsTxt,
        userImpact,
      };
    }
    if (op === 'truncate') {
      return {
        whatHappens: `Deletes all ${rowsTxt} row${rows === 1 ? '' : 's'} from "${fq}" (${sizeTxt}); the table itself stays.`,
        blastRadius: fks.length ? `Referenced by ${fks.length} foreign key${fks.length > 1 ? 's' : ''} (${fks.slice(0, 5).join(', ')}) — TRUNCATE may require CASCADE or fail.` : 'No foreign keys reference this table.',
        userImpact,
      };
    }
    // delete / update (unfiltered classifications) — row count is the headline.
    return {
      whatHappens: `Affects a table holding ${rowsTxt} row${rows === 1 ? '' : 's'} ("${fq}", ${sizeTxt}).`,
      blastRadius: depsTxt,
      userImpact,
    };
  })();

  // Hard timeout so a slow DB can never hang the guard.
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  }
}
