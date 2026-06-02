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
        };
      }
      return null; // can't enrich a missing target for truncate/delete/update; use generic
    }
    const bytes = num(existRows[0].bytes);

    // 2) Exact row count, 3) incoming FKs, 4) RLS policies, 5) dependent views — in parallel.
    const [countRows, fkRows, polRows, viewRows] = await Promise.all([
      q(`SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`),
      q(`SELECT conrelid::regclass::text AS t FROM pg_constraint
         WHERE confrelid = '"${schema}"."${table}"'::regclass AND contype = 'f'`),
      q(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = ${lit} AND tablename = ${tlit}`),
      q(`SELECT DISTINCT view_name FROM information_schema.view_table_usage
         WHERE table_schema = ${lit} AND table_name = ${tlit}`),
    ]);

    const rows = countRows.length ? num(countRows[0].n) : null;
    const fks = fkRows.map((r) => String(r.t)).filter((t) => t && t !== fq);
    const policies = polRows.length ? num(polRows[0].n) : 0;
    const views = viewRows.map((r) => String(r.view_name)).filter(Boolean);

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
      };
    }
    if (op === 'truncate') {
      return {
        whatHappens: `Deletes all ${rowsTxt} row${rows === 1 ? '' : 's'} from "${fq}" (${sizeTxt}); the table itself stays.`,
        blastRadius: fks.length ? `Referenced by ${fks.length} foreign key${fks.length > 1 ? 's' : ''} (${fks.slice(0, 5).join(', ')}) — TRUNCATE may require CASCADE or fail.` : 'No foreign keys reference this table.',
      };
    }
    // delete / update (unfiltered classifications) — row count is the headline.
    return {
      whatHappens: `Affects a table holding ${rowsTxt} row${rows === 1 ? '' : 's'} ("${fq}", ${sizeTxt}).`,
      blastRadius: depsTxt,
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
