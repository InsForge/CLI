import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

interface RecalledMemory {
  id: string;
  kind: string;
  title: string;
  content: string;
  similarity: number;
  updated_at: string;
}

export function registerMemoryRecallCommand(memoryCmd: Command): void {
  memoryCmd
    .command('recall <query>')
    .description('Recall the most relevant memories for a query')
    .option('--scope <scope>', 'Memory scope (project / agent / user)', 'default')
    .option('--limit <n>', 'Max memories to return', '5')
    .option('--threshold <t>', 'Similarity threshold 0-1 (default tuned to 0.45)')
    .action(async (query: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body: Record<string, unknown> = {
          scope: opts.scope,
          query,
          limit: Number(opts.limit),
        };
        if (opts.threshold !== undefined) {
          body.threshold = Number(opts.threshold);
        }

        const res = await ossFetch('/api/memory/recall', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const result = (await res.json()) as { memories: RecalledMemory[] };

        if (json) {
          outputJson(result);
        } else if (result.memories.length === 0) {
          console.log('No relevant memories found.');
        } else {
          for (const m of result.memories) {
            console.log(`[${(m.similarity * 100).toFixed(1)}%] (${m.kind}) ${m.title}`);
            console.log(`        ${m.content}`);
          }
        }
        await reportCliUsage('cli.memory.recall', true);
      } catch (err) {
        handleError(err, json);
      }
    });
}
