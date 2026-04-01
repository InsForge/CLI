import type { Command } from 'commander';
import { ossFetch } from '../lib/api/oss.js';
import { requireAuth } from '../lib/credentials.js';
import { handleError, getRootOpts } from '../lib/errors.js';
import { outputJson, outputTable } from '../lib/output.js';
import { reportCliUsage } from '../lib/skills.js';

const FEATURES = ['db', 'storage', 'functions', 'auth', 'ai', 'realtime'] as const;
const LANGUAGES = ['typescript', 'swift', 'kotlin', 'rest-api'] as const;

export function registerDocsCommand(program: Command): void {
  program
    .command('docs [feature] [language]')
    .description('Browse InsForge SDK documentation')
    .addHelpText('after', `
Features: ${FEATURES.join(', ')}
Languages: ${LANGUAGES.join(', ')}

Examples:
  npx @insforge/cli docs                        List all available docs
  npx @insforge/cli docs instructions           Show setup instructions
  npx @insforge/cli docs db typescript          Show TypeScript database SDK docs
  npx @insforge/cli docs auth swift             Show Swift auth SDK docs
  npx @insforge/cli docs storage rest-api       Show REST API storage docs`)
    .action(async (feature: string | undefined, language: string | undefined, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        await reportCliUsage('cli.docs', true);
        // No args → list all docs
        if (!feature) {
          await listDocs(json);
          return;
        }

        // Single arg → legacy doc type (e.g. "instructions")
        if (!language) {
          await fetchDoc(`/api/docs/${encodeURIComponent(feature)}`, feature, json);
          return;
        }

        // Two args → feature + language
        await fetchDoc(
          `/api/docs/${encodeURIComponent(feature)}/${encodeURIComponent(language)}`,
          `${feature}/${language}`,
          json,
        );
      } catch (err) {
        handleError(err, json);
      }
    });
}

async function listDocs(json: boolean): Promise<void> {
  const res = await ossFetch('/api/docs');
  const data = await res.json() as { data?: DocEntry[] } | DocEntry[];
  const docs = Array.isArray(data) ? data : (data.data ?? []);

  if (json) {
    outputJson(docs);
  } else {
    if (!docs.length) {
      console.log('No documentation available.');
      return;
    }
    outputTable(
      ['Type', 'Endpoint'],
      docs.map((d) => [String(d.type ?? '-'), String(d.endpoint ?? '-')]),
    );
  }
}

async function fetchDoc(path: string, label: string, json: boolean): Promise<void> {
  const res = await ossFetch(path);
  const data = await res.json() as { data?: { type?: string; content?: string }; type?: string; content?: string };
  const doc = data.data ?? data;

  if (json) {
    outputJson(doc);
  } else {
    if (doc.content) {
      console.log(doc.content);
    } else {
      console.log(`No content returned for "${label}".`);
    }
  }
}

interface DocEntry {
  type?: string;
  filename?: string;
  endpoint?: string;
}
