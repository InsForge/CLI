import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';

interface MemoryIndexEntry {
  id: string;
  kind: string;
  title: string;
  updated_at: string;
}

export function registerMemoryListCommand(memoryCmd: Command): void {
  memoryCmd
    .command('list')
    .description('List all memory titles for a scope (the cheap always-load index)')
    .option('--scope <scope>', 'Memory scope (project / agent / user)', 'default')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/memory/index', {
          method: 'POST',
          body: JSON.stringify({ scope: opts.scope }),
        });
        const result = (await res.json()) as { entries: MemoryIndexEntry[] };

        if (json) {
          outputJson(result);
        } else if (result.entries.length === 0) {
          console.log('No memories stored for this scope.');
        } else {
          for (const e of result.entries) {
            console.log(`(${e.kind}) ${e.title}`);
          }
          console.log(`\n${result.entries.length} memories.`);
        }

        const project = getProjectConfig();
        if (project) {
          captureEvent(project.project_id, 'cli_memory_list', {
            project_id: project.project_id,
            entries: result.entries.length,
          });
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
