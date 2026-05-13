import type { Command } from 'commander';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { getOpenRouterApiKey } from '../../lib/api/ai.js';
import { getProjectConfig } from '../../lib/config.js';
import { getRootOpts, handleError, ProjectNotLinkedError } from '../../lib/errors.js';
import { upsertEnvFile } from '../../lib/env-writer.js';
import { outputInfo, outputJson, outputSuccess } from '../../lib/output.js';
import { isInteractive } from '../../lib/prompts.js';

const DEFAULT_ENV_FILE = '.env.local';
const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';

export interface AiSetupResult {
  envFile: string;
  added: string[];
  skipped: string[];
  mismatched: string[];
  gitignoreUpdated: boolean;
  maskedKey?: string;
}

interface RunAiSetupOptions {
  envFile?: string;
  json: boolean;
}

export function registerAiSetupCommand(aiCmd: Command): void {
  aiCmd
    .command('setup')
    .description('Write the linked project OpenRouter key to a local env file')
    .option('--env-file <path>', `Env file to update (default: ${DEFAULT_ENV_FILE})`)
    .action(async (opts: { envFile?: string }, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const result = await runAiSetup({
          envFile: opts.envFile,
          json,
        });

        if (json) {
          outputJson({ success: true, ...result });
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}

export async function runAiSetup(opts: RunAiSetupOptions): Promise<AiSetupResult> {
  const project = getProjectConfig();
  if (!project) {
    throw new ProjectNotLinkedError();
  }

  if (!opts.json) {
    clack.intro('AI setup');
    outputSuccess(`Linked to InsForge project: ${project.project_name} (${project.project_id})`);
  }

  const spinner = !opts.json && isInteractive ? clack.spinner() : null;
  spinner?.start('Fetching OpenRouter key...');
  let key: Awaited<ReturnType<typeof getOpenRouterApiKey>>;
  try {
    key = await getOpenRouterApiKey();
    spinner?.stop('Fetched OpenRouter key.');
  } catch (err) {
    spinner?.stop('Could not fetch OpenRouter key.');
    throw err;
  }
  const envFile = opts.envFile ?? DEFAULT_ENV_FILE;
  const envPath = resolve(process.cwd(), envFile);
  const envLabel = displayPath(envPath);
  const update = upsertEnvFile(envPath, { [OPENROUTER_ENV_KEY]: key.apiKey });
  const gitignoreUpdated = ensureLocalEnvIgnored(process.cwd(), envFile);

  captureEvent(project.project_id, 'cli_ai_setup', {
    project_id: project.project_id,
    project_name: project.project_name,
    org_id: project.org_id,
    region: project.region,
    env_file: envLabel,
    added: update.added.includes(OPENROUTER_ENV_KEY),
    skipped: update.skipped.includes(OPENROUTER_ENV_KEY),
    mismatched: update.mismatched.some((m) => m.key === OPENROUTER_ENV_KEY),
  });

  if (!opts.json) {
    if (update.added.length > 0) {
      outputSuccess(`Wrote ${envLabel}: ${update.added.join(', ')}`);
    }
    if (update.skipped.length > 0) {
      outputInfo(pc.dim(`${envLabel}: ${update.skipped.join(', ')} already set (matching) - left as-is.`));
    }
    for (const m of update.mismatched) {
      clack.log.warn(
        `${envLabel} already has ${m.key}; left existing value untouched. Remove it or pass --env-file to write elsewhere.`,
      );
    }
    if (gitignoreUpdated) {
      outputInfo(pc.dim('Added .env*.local to .gitignore.'));
    }
    if (!isLocalEnvFile(envFile)) {
      clack.log.warn(
        `${envLabel} may be committed unless it is listed in .gitignore. Keep ${OPENROUTER_ENV_KEY} server-only.`,
      );
    }

    outputInfo('');
    outputInfo('Use this key only from server-side code as process.env.OPENROUTER_API_KEY.');
    outputInfo('For deployment, add OPENROUTER_API_KEY to your hosting provider environment.');
    outputInfo(`Do not rename it to ${pc.bold('NEXT_PUBLIC_')}, ${pc.bold('VITE_')}, or ${pc.bold('PUBLIC_')}.`);
    clack.outro('Done.');
  }

  return {
    envFile: envLabel,
    added: update.added,
    skipped: update.skipped,
    mismatched: update.mismatched.map((m) => m.key),
    gitignoreUpdated,
    maskedKey: key.maskedKey,
  };
}

function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return path;
  }
  return rel;
}

function isLocalEnvFile(envFile: string): boolean {
  const normalized = envFile.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  return basename === '.env.local' || /^\.env\..+\.local$/.test(basename);
}

export function ensureLocalEnvIgnored(cwd: string, envFile: string): boolean {
  if (!isLocalEnvFile(envFile)) return false;

  const envPath = resolve(cwd, envFile);
  const relEnvPath = relative(cwd, envPath);
  if (!relEnvPath || relEnvPath.startsWith('..') || isAbsolute(relEnvPath)) {
    return false;
  }

  const gitignorePath = join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const envBasename = envFile.replace(/\\/g, '/').split('/').pop() ?? envFile;
  if (
    lines.has('.env*') ||
    lines.has('.env.*') ||
    lines.has('.env*.local') ||
    (lines.has('.env.local') && envBasename === '.env.local')
  ) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const spacer = existing.length > 0 ? '\n' : '';
  appendFileSync(gitignorePath, `${prefix}${spacer}# Local environment secrets\n.env*.local\n`);
  return true;
}
