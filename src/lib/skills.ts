import { exec } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as clack from '@clack/prompts';

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

export async function installSkills(json: boolean): Promise<void> {
  try {
    if (!json) clack.log.info('Installing InsForge agent skills...');
    await execAsync('npx skills add insforge/agent-skills -y -a antigravity -a augment -a claude-code -a cline -a codex -a cursor -a gemini-cli -a github-copilot -a kilo -a qoder -a qwen-code -a roo -a trae -a windsurf', {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    if (!json) clack.log.success('InsForge agent skills installed.');
  } catch {
    if (!json) clack.log.warn('Failed to install agent skills. You can run manually: npx skills add insforge/agent-skills');
  }

  try {
    updateGitignore();
  } catch {
    // non-critical, silently ignore
  }
}
