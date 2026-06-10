import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

interface RememberResult {
  action: 'ADD' | 'UPDATE' | 'NOOP';
  id?: string;
  title: string;
}

export function registerMemoryRememberCommand(memoryCmd: Command): void {
  memoryCmd
    .command('remember [content]')
    .description('Store a durable memory, or extract memories from a task transcript')
    .option('--scope <scope>', 'Memory scope (project / agent / user)', 'default')
    .option('--kind <kind>', 'fact | decision | preference | reference', 'fact')
    .option('--title <title>', 'One-line title (defaults to the content)')
    .option('--source <source>', 'Where this memory came from (task / session id)')
    .option('--transcript', 'Treat the content as a task transcript to extract memories from')
    .option('--file <path>', 'Read the transcript/content from a file')
    .action(async (content: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const text = opts.file ? readFileSync(opts.file, 'utf8') : content;
        if (!text) {
          throw new Error('Provide content as an argument or via --file');
        }

        const body = opts.transcript || opts.file
          ? { scope: opts.scope, source: opts.source, transcript: text }
          : { scope: opts.scope, source: opts.source, kind: opts.kind, title: opts.title ?? text, content: text };

        const res = await ossFetch('/api/memory/remember', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const result = (await res.json()) as { results: RememberResult[] };

        if (json) {
          outputJson(result);
        } else {
          for (const r of result.results) {
            console.log(`${r.action.padEnd(6)} ${r.title}`);
          }
          const stored = result.results.filter((r) => r.action !== 'NOOP').length;
          console.log(`\n${stored} stored, ${result.results.length - stored} unchanged.`);
        }
        await reportCliUsage('cli.memory.remember', true);
      } catch (err) {
        handleError(err, json);
      }
    });
}
