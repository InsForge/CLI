import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';

export function registerDbExportCommand(dbCmd: Command): void {
  dbCmd
    .command('export')
    .description('Export database schema and/or data')
    .option('--format <format>', 'Export format: sql or json', 'sql')
    .option('--tables <tables>', 'Comma-separated list of tables to export (default: all)')
    .option('--no-data', 'Exclude table data (schema only)')
    .option('--include-functions', 'Include database functions')
    .option('--include-sequences', 'Include sequences')
    .option('--include-views', 'Include views')
    .option('--row-limit <n>', 'Maximum rows per table')
    .option('-o, --output <file>', 'Output file path (default: stdout)')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const body: Record<string, unknown> = {
          format: opts.format,
          includeData: opts.data !== false,
        };

        if (opts.tables) {
          body.tables = (opts.tables as string).split(',').map((t: string) => t.trim());
        }
        if (opts.includeFunctions) body.includeFunctions = true;
        if (opts.includeSequences) body.includeSequences = true;
        if (opts.includeViews) body.includeViews = true;
        if (opts.rowLimit) body.rowLimit = parseInt(opts.rowLimit as string, 10);

        const res = await ossFetch('/api/database/advance/export', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        const raw = await res.text();

        // API may return JSON wrapper { format, content, tables } or raw SQL/JSON text
        let content: string;
        let meta: { format?: string; tables?: string[] } | null = null;
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.content === 'string') {
            content = parsed.content;
            meta = { format: parsed.format as string, tables: parsed.tables as string[] };
          } else {
            content = raw;
          }
        } catch {
          content = raw;
        }

        if (json) {
          outputJson(meta ?? { content });
          return;
        }

        if (opts.output) {
          writeFileSync(opts.output as string, content);
          const tableCount = meta?.tables?.length;
          const suffix = tableCount ? ` (${tableCount} tables, format: ${meta?.format ?? opts.format})` : '';
          outputSuccess(`Exported to ${opts.output}${suffix}`);
        } else {
          console.log(content);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
