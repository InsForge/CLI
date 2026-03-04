import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import type { StorageBucketSchema } from '../../types.js';

export function registerStorageBucketsCommand(storageCmd: Command): void {
  storageCmd
    .command('buckets')
    .description('List all storage buckets')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/storage/buckets');
        const raw = await res.json();
        // API may return array directly or { buckets: [...] }
        const buckets: StorageBucketSchema[] = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object' && 'buckets' in raw
            ? (raw as { buckets?: StorageBucketSchema[] }).buckets ?? []
            : [];

        if (json) {
          outputJson(raw);
        } else {
          if (buckets.length === 0) {
            console.log('No buckets found.');
            return;
          }
          outputTable(
            ['Bucket Name', 'Public'],
            buckets.map((b) => [b.name, b.public ? 'Yes' : 'No']),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
