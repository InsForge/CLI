import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

interface StoredFile {
  key: string;
  size: number;
  mimeType?: string;
  uploadedAt: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerStorageListObjectsCommand(storageCmd: Command): void {
  storageCmd
    .command('list-objects <bucket>')
    .description('List objects in a storage bucket')
    .option('--limit <n>', 'Maximum number of objects to return', '100')
    .option('--offset <n>', 'Number of objects to skip', '0')
    .option('--prefix <prefix>', 'Filter objects by key prefix')
    .option('--search <term>', 'Search objects by key (partial match)')
    .option('--sort <field>', 'Sort by field: key, size, uploadedAt (default: key)')
    .action(async (bucket: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const params = new URLSearchParams();
        params.set('limit', opts.limit);
        params.set('offset', opts.offset);
        if (opts.prefix) params.set('prefix', opts.prefix);
        if (opts.search) params.set('search', opts.search);

        const res = await ossFetch(
          `/api/storage/buckets/${encodeURIComponent(bucket)}/objects?${params.toString()}`,
        );
        const raw = await res.json() as { data?: StoredFile[]; pagination?: { total?: number } };

        const objects: StoredFile[] = Array.isArray(raw)
          ? raw as StoredFile[]
          : (raw.data ?? []);

        // Client-side sort
        const sortField = opts.sort ?? 'key';
        objects.sort((a, b) => {
          if (sortField === 'size') return a.size - b.size;
          if (sortField === 'uploadedAt') return a.uploadedAt.localeCompare(b.uploadedAt);
          return a.key.localeCompare(b.key);
        });

        await trackCommandUsage('storage', 'list-objects', true, {
          result_count: objects.length,
        });

        if (json) {
          outputJson(raw);
        } else {
          if (objects.length === 0) {
            console.log(`No objects found in bucket "${bucket}".`);
            return;
          }
          const total = raw.pagination?.total;
          if (total !== undefined) {
            console.log(`Showing ${objects.length} of ${total} objects:\n`);
          }
          outputTable(
            ['Key', 'Size', 'Type', 'Uploaded At'],
            objects.map((o) => [
              o.key,
              formatSize(o.size),
              o.mimeType ?? '-',
              o.uploadedAt,
            ]),
          );
        }
        await reportCliUsage('cli.storage.list-objects', true);
      } catch (err) {
        await reportCliUsage('cli.storage.list-objects', false);
        await trackCommandUsage('storage', 'list-objects', false, {}, err);
        handleError(err, json);
      }
    });
}
