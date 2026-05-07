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
  lines.push(
    `${s.add} add, ${s.modify} modify, ${s.remove} remove, ${s.kept} untracked kept.`,
  );

  return lines.join('\n');
}

function formatChange(c: DiffChange): string {
  return `~ ${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
}
