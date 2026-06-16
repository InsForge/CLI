/**
 * Append-only audit trail for guard decisions.
 * Every dangerous operation the guard evaluates is recorded, regardless of
 * whether it was approved, denied, timed out, or bypassed.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Decision = 'approved' | 'denied' | 'timeout' | 'bypassed' | 'failed' | 'needs_brief';

export interface AuditEntry {
  ts: string;
  path: string;
  command: string;
  kind: string;
  severity: string;
  decision: Decision;
}

const AUDIT_DIR = join(homedir(), '.insforge');
const AUDIT_FILE = join(AUDIT_DIR, 'guard-audit.jsonl');

/** Best-effort audit write — never throws into the command path. */
export function audit(entry: AuditEntry): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch {
    /* auditing must never block the guard */
  }
}

export { AUDIT_FILE };
