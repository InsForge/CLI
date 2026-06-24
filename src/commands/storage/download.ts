import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Command } from 'commander';
import { getProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerStorageDownloadCommand(storageCmd: Command): void {
  storageCmd
    .command('download <objectKey>')
    .description('Download a file from a storage bucket')
    .requiredOption('--bucket <name>', 'Source bucket name')
    .option('--output <path>', 'Output file path (defaults to current directory)')
    .action(async (objectKey: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        const bucketName = opts.bucket;
        const url = `${config.oss_host}/api/storage/buckets/${encodeURIComponent(bucketName)}/objects/${encodeURIComponent(objectKey)}`;

        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${config.api_key}`,
          },
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new CLIError(err.error ?? `Download failed: ${res.status}`);
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        const outputPath = opts.output ?? join(process.cwd(), basename(objectKey));
        writeFileSync(outputPath, buffer);

        await trackCommandUsage('storage', 'download', true);

        if (json) {
          outputJson({ success: true, path: outputPath, size: buffer.length });
        } else {
          outputSuccess(`Downloaded "${objectKey}" to ${outputPath} (${buffer.length} bytes).`);
        }
      } catch (err) {
        await trackCommandUsage('storage', 'download', false, {}, err);
        handleError(err, json);
      }
    });
}
