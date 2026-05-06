// CLI/src/lib/config-format.ts
import type { DiffChange, DiffResult } from './config-diff.js';

export function formatPlan(result: DiffResult): string {
  if (result.changes.length === 0) {
    return 'No changes. Live state matches insforge.toml.';
  }

  const bySection = new Map<string, DiffChange[]>();
  for (const c of result.changes) {
    const arr = bySection.get(c.section) ?? [];
    arr.push(c);
    bySection.set(c.section, arr);
  }

  const lines: string[] = [];
  for (const [section, changes] of bySection) {
    lines.push(`  ${section}:`);
    for (const c of changes) {
      lines.push(`    ${formatChange(c)}`);
    }
    lines.push('');
  }

  const s = result.summary;
  lines.push(`${s.add} add, ${s.modify} modify, ${s.remove} remove, ${s.kept} untracked kept.`);

  return lines.join('\n');
}

function formatChange(c: DiffChange): string {
  if (c.section === 'auth' && c.op === 'modify') {
    return `~ ${String(c.key)}: ${formatValue(c.from)} → ${formatValue(c.to)}`;
  }
  if (c.section === 'storage.buckets') {
    if (c.op === 'add') return `+ ${c.key} (${formatBucket(c.value)})`;
    if (c.op === 'modify') return `~ ${c.key}: ${c.field} ${c.from} → ${c.to}`;
    if (c.op === 'remove') {
      return c.kept
        ? `- ${c.key} (in DB, not in file — KEPT; use --prune to delete)`
        : `- ${c.key} (will be deleted)`;
    }
  }
  return `? ${JSON.stringify(c)}`;
}

function formatBucket(b: { public?: boolean }): string {
  return b.public ? 'public' : 'private';
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}
