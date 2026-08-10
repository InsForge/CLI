import { describe, expect, it } from 'vitest';
import { formatIncidentReport } from './incident.js';

// The command's human-readable output contract: every evidence field the
// backend sends must surface next to the verdict.

function baseReport() {
  return {
    project_id: 'p1',
    project_status: 'active',
    operation_status: null,
    instance_type: 'nano',
    reachable: {
      metrics_last_seen_at: '2026-08-10T14:32:00Z',
      metrics_reporting: false,
      database_connect: false,
    },
    down_since: '2026-08-10T14:32:00Z',
    memory_before_down_pct: 96.4,
    memory_latest_pct: null,
    postgres_started_at: null,
    scrape_gaps_24h: 2,
    recent_platform_operations: [],
    verdict: 'oom_likely',
    explanation: 'The instance stopped reporting with memory at 96.4% right before.',
    recommendation: 'Upgrade to a larger instance.',
  };
}

describe('formatIncidentReport', () => {
  it('renders the OOM verdict with the facts behind it', () => {
    const text = formatIncidentReport(baseReport()).join('\n');
    expect(text).toContain('Verdict: Out of memory (likely)');
    expect(text).toContain('not reporting');
    expect(text).toContain('Database connection: unreachable');
    expect(text).toContain('Memory right before: 96.4%');
    expect(text).toContain('Reporting gaps in the last 24h: 2');
    expect(text).toContain('Instance type: nano');
    expect(text).toContain('What to do: Upgrade to a larger instance.');
  });

  it('surfaces project status and in-flight platform operation as facts', () => {
    const report = {
      ...baseReport(),
      project_status: 'paused',
      operation_status: 'upgrading_instance_type',
      verdict: 'platform_operation_in_progress',
    };
    const text = formatIncidentReport(report).join('\n');
    expect(text).toContain('Project status: paused');
    expect(text).toContain('Platform operation in progress: upgrading_instance_type');
  });

  it('lists recent platform operations that explain a restart', () => {
    const report = {
      ...baseReport(),
      verdict: 'no_incident_detected',
      recent_platform_operations: [{ action: 'reset_project', at: '2026-08-10T12:00:00Z' }],
    };
    const text = formatIncidentReport(report).join('\n');
    expect(text).toContain('Recent platform operation: reset_project at');
  });

  it('falls back to the raw verdict string for unknown verdicts (forward compatibility)', () => {
    const text = formatIncidentReport({ ...baseReport(), verdict: 'new_verdict' }).join('\n');
    expect(text).toContain('Verdict: new_verdict');
  });
});
