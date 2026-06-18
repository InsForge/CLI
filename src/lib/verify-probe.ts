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

export async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return extractToken(await res.json().catch(() => ({})));
}

export async function getAnonKey(baseUrl: string, adminKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/tokens/anon`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  return extractToken(await res.json().catch(() => ({})));
}

export async function rawsqlRows(baseUrl: string, adminKey: string, query: string): Promise<unknown[]> {
  const res = await fetch(`${baseUrl}/api/database/advance/rawsql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({ query, params: [] }),
  });
  return extractRows(await res.json().catch(() => ({})));
}

/** Count rows from the data API. A 401/403 (or any non-2xx) counts as 0 rows. */
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
  if (!res.ok) return 0;
  return extractRows(await res.json().catch(() => [])).length;
}
