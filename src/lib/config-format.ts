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
  if (c.section === 'auth.smtp') {
    const lines = [`~ smtp config:`];
    const from = c.from;
    const to = c.to;
    for (const key of [
      'enabled',
      'host',
      'port',
      'username',
      'password',
      'sender_email',
      'sender_name',
      'min_interval_seconds',
    ] as const) {
      if (from[key] !== to[key]) {
        lines.push(`    ${key}: ${JSON.stringify(from[key])} → ${JSON.stringify(to[key])}`);
      }
    }
    if (c.passwordEnvRef) {
      lines.push(`    (password force-resent from env(${c.passwordEnvRef}))`);
    }
    return lines.join('\n    ');
  }
  if (c.section === 'auth.email_templates') {
    const lines = [`~ ${c.key}:`];
    if (c.from.subject !== c.to.subject) {
      lines.push(
        `    subject: ${formatTextValue(c.from.subject)} → ${formatTextValue(c.to.subject)}`,
      );
    }
    if (c.from.body_html !== c.to.body_html) {
      lines.push(
        `    body_html: ${formatTextValue(c.from.body_html)} → ${formatTextValue(c.to.body_html)}`,
      );
    }
    return lines.join('\n    ');
  }
  if (c.section === 'deployments' && c.key === 'subdomain') {
    const fromLabel = c.from === null ? '(unset)' : JSON.stringify(c.from);
    const toLabel = c.to === null ? '(unset)' : JSON.stringify(c.to);
    return `~ ${c.key}: ${fromLabel} → ${toLabel}`;
  }
  return `~ ${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
}

function formatTextValue(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  const shortened = collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
  return JSON.stringify(shortened);
}
