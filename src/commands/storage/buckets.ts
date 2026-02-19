import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

export function registerStorageBucketsCommand(storageCmd: Command): void {
  storageCmd
    .command('buckets')
    .description('List all storage buckets')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();

        const res = await ossFetch('/api/storage/buckets');
        const raw = await res.json() as unknown;

        // API may return { buckets: string[] } or string[] directly
        let buckets: string[];
        if (Array.isArray(raw)) {
          buckets = raw as string[];
        } else if (raw && typeof raw === 'object' && 'buckets' in raw && Array.isArray((raw as Record<string, unknown>).buckets)) {
          buckets = (raw as Record<string, unknown>).buckets as string[];
        } else {
          // Fallback: find first array in response
          const arr = raw && typeof raw === 'object' ? Object.values(raw).find(Array.isArray) : null;
          buckets = (arr as string[] | null) ?? [];
        }

        if (json) {
          outputJson(raw);
        } else {
          if (buckets.length === 0) {
            console.log('No buckets found.');
            return;
          }
          outputTable(
            ['Bucket Name'],
            buckets.map((b) => [typeof b === 'string' ? b : JSON.stringify(b)]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
