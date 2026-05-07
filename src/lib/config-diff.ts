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
    const fromV = liveAuth.allowed_redirect_urls ?? [];
    const toV = fileAuth.allowed_redirect_urls ?? [];
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

function arrayEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
