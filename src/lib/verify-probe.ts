// Deterministic verify probes for `insforge verify rls/truth`.
//
// The verdict logic is pure + unit-tested; the fetch wiring is a thin layer on
// top. Findings are emitted via `trackVerifyFinding` (src/lib/analytics.ts) so the
// recording is in the tool, not in agent prose.

export type RlsFindingType = 'rls_leak' | 'rls_overrestrict' | 'none';
export type TruthFindingType = 'false_pass' | 'none';

/**
 * Classify a cross-user RLS isolation probe from its row counts. Deterministic:
 * - B reading A's rows (or anon reading any) -> rls_leak
 * - A failing to read its own rows (positive control empty) -> rls_overrestrict
 *   (catches a policy that silently empties a real user's data — the break no
 *   scanner catches, since it returns 200 + [])
 */
export function classifyRls(input: {
  bReadRowsOfA: number;
  aReadOwnRows: number;
  anonReadRows: number;
}): { type: RlsFindingType; evidence: Record<string, unknown> } {
  const evidence = {
    user_b_read_rows_of_a: input.bReadRowsOfA,
    user_a_read_own_rows: input.aReadOwnRows,
    anon_read_rows: input.anonReadRows,
  };
  if (input.bReadRowsOfA > 0) return { type: 'rls_leak', evidence };
  if (input.anonReadRows > 0) return { type: 'rls_leak', evidence };
  if (input.aReadOwnRows === 0) return { type: 'rls_overrestrict', evidence };
  return { type: 'none', evidence };
}

function normalizeScalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * Classify a backend-truth check. The UI claimed `expected`; the DB returned
 * `dbValue`. A mismatch is a false pass (the write returned 200 + optimistic UI
 * but never persisted, or persisted the wrong value). Compared as normalized
 * scalars so `3` and `"3"` agree.
 */
export function classifyTruth(
  dbValue: unknown,
  expected: string,
): { type: TruthFindingType; evidence: Record<string, unknown> } {
  const evidence = { ui_claimed: expected, db_actual: dbValue };
  return {
    type: normalizeScalar(dbValue) === normalizeScalar(expected) ? 'none' : 'false_pass',
    evidence,
  };
}

/**
 * A query is safe for `verify truth` only if it's a single read — starts with SELECT or
 * WITH and chains no further statements (a trailing `;` is fine). Guards against an
 * agent-generated destructive query (`DELETE FROM …`, `…; UPDATE …`) running with the
 * admin key. Not a full SQL parser, but it blocks the common destructive shapes.
 */
export function isReadOnlyQuery(query: string): boolean {
  const q = query.trim();
  if (!/^(select|with)\b/i.test(q)) return false;
  // No statement chaining beyond a single trailing semicolon.
  if (q.replace(/;\s*$/, '').includes(';')) return false;
  if (/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i.test(q)) return false;
  return true;
}

// ---- fetch wiring (not unit-tested; the verdicts above are) ----

function extractToken(j: unknown): string {
  const obj = j as { accessToken?: string; data?: { accessToken?: string } };
  return obj?.accessToken ?? obj?.data?.accessToken ?? '';
}

function extractRows(j: unknown): unknown[] {
  if (Array.isArray(j)) return j;
  const obj = j as { data?: unknown[]; records?: unknown[]; rows?: unknown[] };
  return obj?.data ?? obj?.records ?? obj?.rows ?? [];
}

/** Throw on a non-2xx response so a backend error (expired key, bad SQL, 500) isn't read
 *  as an empty/zero result — which would masquerade as a passing probe. */
async function assertOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new Error(`${what} failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
}

export async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  await assertOk(res, `login (${email})`);
  return extractToken(await res.json().catch(() => ({})));
}

export async function getAnonKey(baseUrl: string, adminKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/tokens/anon`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  await assertOk(res, 'anon-key fetch');
  return extractToken(await res.json().catch(() => ({})));
}

export async function rawsqlRows(baseUrl: string, adminKey: string, query: string): Promise<unknown[]> {
  const res = await fetch(`${baseUrl}/api/database/advance/rawsql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({ query, params: [] }),
  });
  await assertOk(res, 'rawsql query');
  return extractRows(await res.json().catch(() => ({})));
}

/** Count rows from the data API. A 401/403 (RLS/auth blocked) counts as 0 rows — the
 *  expected "can't see it" result; any other non-2xx throws so a transport/server error
 *  isn't read as 0 rows (which would be a false isolation pass). */
export async function recordsCount(
  baseUrl: string,
  table: string,
  query: string | undefined,
  token: string | undefined,
  anon: string,
): Promise<number> {
  const url = `${baseUrl}/api/database/records/${encodeURIComponent(table)}${query ? `?${query}` : ''}`;
  const headers: Record<string, string> = { apikey: anon };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 401 || res.status === 403) return 0;
  await assertOk(res, `data API read (${table})`);
  return extractRows(await res.json().catch(() => [])).length;
}
