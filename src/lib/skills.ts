import { exec } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as clack from '@clack/prompts';
import { getProjectConfig } from './config.js';

const execAsync = promisify(exec);

const GITIGNORE_ENTRIES = [
  '.insforge',
  '.agent',
  '.agents',
  '.augment',
  '.claude',
  '.cline',
  '.github/copilot*',
  '.kilocode',
  '.qoder',
  '.qwen',
  '.roo',
  '.trae',
  '.windsurf',
];

function updateGitignore(): void {
  const gitignorePath = join(process.cwd(), '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const lines = new Set(existing.split('\n').map((l) => l.trim()));

  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (!missing.length) return;

  const block = `\n# InsForge & AI agent skills\n${missing.join('\n')}\n`;
  appendFileSync(gitignorePath, block);
}
export async function installCliGlobally(json: boolean): Promise<void> {
  try {
    const { stdout } = await execAsync('npm ls -g @insforge/cli --json', { timeout: 10_000 });
    const parsed = JSON.parse(stdout);
    if (parsed?.dependencies?.['@insforge/cli']) return;
  } catch {
    // not installed globally — proceed with install
  }

  try {
    if (!json) clack.log.info('Installing InsForge CLI globally...');
    await execAsync('npm install -g @insforge/cli', { timeout: 60_000 });
    if (!json) clack.log.success('InsForge CLI installed. You can now run `insforge` directly.');
  } catch {
    if (!json) clack.log.warn('Failed to install CLI globally. You can run manually: npm install -g @insforge/cli');
  }
}

export async function installSkills(json: boolean): Promise<void> {
  try {
    if (!json) clack.log.info('Installing InsForge agent skills...');
    await execAsync('npx skills add insforge/agent-skills -y -s insforge -s insforge-cli -a antigravity -a augment -a claude-code -a cline -a codex -a cursor -a gemini-cli -a github-copilot -a kilo -a qoder -a qwen-code -a roo -a trae -a windsurf', {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    if (!json) clack.log.success('InsForge agent skills installed.');
  } catch {
    if (!json) clack.log.warn('Failed to install agent skills. You can run manually: npx skills add insforge/agent-skills -s insforge -s insforge-cli');
  }

  try {
    updateGitignore();
  } catch {
    // non-critical, silently ignore
  }
}

export async function reportCliUsage(toolName: string, success: boolean, maxRetries = 1): Promise<void> {
  let config;
  try {
    config = getProjectConfig();
  } catch {
    return;
  }
  if (!config) return;

  const payload = JSON.stringify({
    tool_name: toolName,
    success,
    timestamp: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const res = await fetch(`${config.oss_host}/api/usage/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.api_key,
          },
          body: payload,
          signal: controller.signal,
        });

        if (res.status < 500) return;
        // 5xx — server may not be ready yet, retry
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // network/abort error — server may not be ready yet, retry
    }

    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
