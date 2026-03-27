import type { Command } from 'commander';
import { runRawSql } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

interface DbCheck {
  label: string;
  sql: string;
  format: (rows: Record<string, unknown>[]) => void;
}

const DB_CHECKS: Record<string, DbCheck> = {
  connections: {
    label: 'Connections',
    sql: `SELECT
      (SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL) AS active,
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max`,
    format(rows) {
      const r = rows[0] ?? {};
      console.log(`  Active: ${r.active} / ${r.max}`);
    },
  },
  'slow-queries': {
    label: 'Slow Queries (>5s)',
    sql: `SELECT pid, now() - query_start AS duration, substring(query for 80) AS query
      FROM pg_stat_activity
      WHERE state = 'active' AND now() - query_start > interval '5 seconds'
      ORDER BY query_start ASC`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  None');
        return;
      }
      const headers = ['PID', 'Duration', 'Query'];
      const tableRows = rows.map((r) => [
        String(r.pid ?? ''),
        String(r.duration ?? ''),
        String(r.query ?? ''),
      ]);
      outputTable(headers, tableRows);
    },
  },
  bloat: {
    label: 'Table Bloat (top 10)',
    sql: `SELECT schemaname || '.' || relname AS table, n_dead_tup AS dead_tuples
      FROM pg_stat_user_tables
      ORDER BY n_dead_tup DESC
      LIMIT 10`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  No user tables found.');
        return;
      }
      const headers = ['Table', 'Dead Tuples'];
      const tableRows = rows.map((r) => [
        String(r.table ?? ''),
        String(r.dead_tuples ?? 0),
      ]);
      outputTable(headers, tableRows);
    },
  },
  size: {
    label: 'Table Sizes (top 10)',
    sql: `SELECT schemaname || '.' || relname AS table,
        pg_size_pretty(pg_total_relation_size(relid)) AS size
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 10`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  No user tables found.');
        return;
      }
      const headers = ['Table', 'Size'];
      const tableRows = rows.map((r) => [
        String(r.table ?? ''),
        String(r.size ?? ''),
      ]);
      outputTable(headers, tableRows);
    },
  },
  'index-usage': {
    label: 'Index Usage (worst 10)',
    sql: `SELECT schemaname || '.' || relname AS table, idx_scan, seq_scan,
        CASE WHEN (idx_scan + seq_scan) > 0
          THEN round(100.0 * idx_scan / (idx_scan + seq_scan), 1)
          ELSE 0 END AS idx_ratio
      FROM pg_stat_user_tables
      WHERE (idx_scan + seq_scan) > 0
      ORDER BY idx_ratio ASC
      LIMIT 10`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  No scan data available.');
        return;
      }
      const headers = ['Table', 'Index Scans', 'Seq Scans', 'Index Ratio'];
      const tableRows = rows.map((r) => [
        String(r.table ?? ''),
        String(r.idx_scan ?? 0),
        String(r.seq_scan ?? 0),
        `${r.idx_ratio ?? 0}%`,
      ]);
      outputTable(headers, tableRows);
    },
  },
  locks: {
    label: 'Waiting Locks',
    sql: `SELECT pid, mode, relation::regclass AS relation, granted
      FROM pg_locks
      WHERE NOT granted`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  None');
        return;
      }
      const headers = ['PID', 'Mode', 'Relation', 'Granted'];
      const tableRows = rows.map((r) => [
        String(r.pid ?? ''),
        String(r.mode ?? ''),
        String(r.relation ?? ''),
        String(r.granted ?? ''),
      ]);
      outputTable(headers, tableRows);
    },
  },
  'cache-hit': {
    label: 'Cache Hit Ratio',
    sql: `SELECT CASE WHEN sum(heap_blks_hit + heap_blks_read) > 0
        THEN round(100.0 * sum(heap_blks_hit) / sum(heap_blks_hit + heap_blks_read), 1)
        ELSE 0 END AS ratio
      FROM pg_statio_user_tables`,
    format(rows) {
      const ratio = rows[0]?.ratio ?? 0;
      console.log(`  ${ratio}%`);
    },
  },
};

const ALL_CHECKS = Object.keys(DB_CHECKS);

export async function runDbChecks(): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {};
  for (const key of ALL_CHECKS) {
    try {
      const { rows } = await runRawSql(DB_CHECKS[key].sql, true);
      results[key] = rows;
    } catch {
      results[key] = [];
    }
  }
  return results;
}

export function registerDiagnoseDbCommand(diagnoseCmd: Command): void {
  diagnoseCmd
    .command('db')
    .description('Run database health checks (connections, bloat, index usage, etc.)')
    .option('--check <checks>', 'Comma-separated checks: ' + ALL_CHECKS.join(', '), 'all')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const checkNames =
          opts.check === 'all'
            ? ALL_CHECKS
            : (opts.check as string).split(',').map((s: string) => s.trim());

        const results: Record<string, Record<string, unknown>[]> = {};

        for (const name of checkNames) {
          const check = DB_CHECKS[name];
          if (!check) {
            console.error(`Unknown check: ${name}. Available: ${ALL_CHECKS.join(', ')}`);
            continue;
          }
          try {
            const { rows } = await runRawSql(check.sql, true);
            results[name] = rows;
          } catch (err) {
            results[name] = [];
            if (!json) {
              console.error(`  Failed to run ${name}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }

        if (json) {
          outputJson(results);
        } else {
          for (const name of checkNames) {
            const check = DB_CHECKS[name];
            if (!check) continue;
            console.log(`\n── ${check.label} ${'─'.repeat(Math.max(0, 40 - check.label.length))}`);
            check.format(results[name] ?? []);
          }
          console.log('');
        }
        await reportCliUsage('cli.diagnose.db', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose.db', false);
        handleError(err, json);
      }
    });
}
