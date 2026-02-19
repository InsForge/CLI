import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { getProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';

export function registerDbImportCommand(dbCmd: Command): void {
  dbCmd
    .command('import <file>')
    .description('Import database from a local SQL file')
    .option('--truncate', 'Truncate existing tables before import')
    .action(async (file: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        const fileContent = readFileSync(file);
        const fileName = basename(file);

        const formData = new FormData();
        formData.append('file', new Blob([fileContent]), fileName);
        if (opts.truncate) {
          formData.append('truncate', 'true');
        }

        const res = await fetch(`${config.oss_host}/api/database/advance/import`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.api_key}`,
          },
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new CLIError(err.error ?? `Import failed: ${res.status}`);
        }

        const data = await res.json() as { filename: string; fileSize: number; tables: string[]; rowsImported: number };

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Imported ${data.filename} (${data.tables.length} tables, ${data.rowsImported} rows)`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
