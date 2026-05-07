import type { InsforgeConfig } from './config-schema.js';

export type DiffChange = {
  section: 'auth';
  op: 'modify';
  key: 'allowed_redirect_urls';
  from: string[];
  to: string[];
};

export interface DiffSummary {
  add: number;
  modify: number;
  remove: number;
  kept: number;
}

export interface DiffResult {
  changes: DiffChange[];
  summary: DiffSummary;
}

export interface DiffInput {
  live: InsforgeConfig;
  file: InsforgeConfig;
}

/**
 * Compute the changes the file would impose on the live state.
 * v1 scope: auth.allowed_redirect_urls only. Default-keep for absent fields
 * — if the file omits a section, live state is left alone.
 */
export function diffConfig({ live, file }: DiffInput): DiffResult {
  const changes: DiffChange[] = [];

  const fileAuth = file.auth;
  const liveAuth = live.auth ?? {};

  if (fileAuth && 'allowed_redirect_urls' in fileAuth) {
    // Treat the redirect allowlist as a set: order and duplicates in the TOML
    // shouldn't produce a diff. Reorder/dedupe both sides before comparing,
    // and emit the normalized values so the change rendered to the user
    // (and the request body sent on apply) matches what's actually different.
    const fromV = normalizeUrlList(liveAuth.allowed_redirect_urls);
    const toV = normalizeUrlList(fileAuth.allowed_redirect_urls);
    if (!arrayEquals(fromV, toV)) {
      changes.push({
        section: 'auth',
        op: 'modify',
        key: 'allowed_redirect_urls',
        from: fromV,
        to: toV,
      });
    }
  }

  return { changes, summary: summarize(changes) };
}

function summarize(changes: DiffChange[]): DiffSummary {
  const s: DiffSummary = { add: 0, modify: 0, remove: 0, kept: 0 };
  for (const c of changes) {
    if (c.op === 'modify') s.modify++;
  }
  return s;
}

function normalizeUrlList(input: string[] | undefined): string[] {
  return Array.from(new Set(input ?? [])).sort();
}

function arrayEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
