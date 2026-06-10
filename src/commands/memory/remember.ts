import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';

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
    .option('--file <path>', 'Read the content/transcript text from a file')
    .action(async (content: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        // --file is just a text source; --transcript decides the mode, so
        // `--file foo.txt` alone still stores a single fact honoring --kind/--title.
        const text = opts.file ? readFileSync(opts.file, 'utf8') : content;
        if (!text) {
          throw new Error('Provide content as an argument or via --file');
        }

        const body = opts.transcript
          ? { scope: opts.scope, source: opts.source, transcript: text }
          : {
              scope: opts.scope,
              source: opts.source,
              kind: opts.kind,
              title: opts.title ?? text,
              content: text,
            };

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

        const project = getProjectConfig();
        if (project) {
          captureEvent(project.project_id, 'cli_memory_remember', {
            project_id: project.project_id,
            mode: opts.transcript ? 'transcript' : 'single',
            from_file: Boolean(opts.file),
            results: result.results.length,
          });
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
