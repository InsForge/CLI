import { exec } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as clack from '@clack/prompts';
import { getProjectConfig } from './config.js';

const execAsync = promisify(exec);

const SKILL_INSTALL_TIMEOUT_MS = 60_000;

function describeExecError(err: unknown): string {
  const e = err as {
    killed?: boolean;
    signal?: string;
    code?: number | string;
    stderr?: string | Buffer;
    message?: string;
  };

  if (e.killed && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL')) {
    return `timed out after ${SKILL_INSTALL_TIMEOUT_MS / 1000}s — the npm registry may be slow or blocked by your network`;
  }
  if (e.code === 'ENOENT') {
    return '`npx` is not on your PATH — install Node.js 18+ and reopen your shell';
  }

  const stderr = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString()) ?? '';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(stderr)) return 'cannot reach the npm registry (DNS lookup failed) — check your internet connection';
  if (/ECONNREFUSED/i.test(stderr)) return 'connection to the npm registry was refused — a proxy or firewall is likely blocking it';
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|network timeout/i.test(stderr)) return 'the npm registry timed out — check your VPN, proxy, or corporate network';
  if (/CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT/i.test(stderr)) return 'TLS error reaching the npm registry — a corporate proxy may be intercepting HTTPS';
  if (/\bE404\b|404 Not Found/i.test(stderr)) return 'npm returned 404 — the `skills` package or a dependency could not be found (check your npm registry config)';
  if (/EACCES|permission denied/i.test(stderr)) return 'permission denied writing files — run from a directory you own, without sudo';
  if (/ENOSPC|no space left/i.test(stderr)) return 'no disk space left to install the package';
  if (/\b401\b|EAUTH|authentication/i.test(stderr)) return 'npm authentication failed — check ~/.npmrc';

  if (typeof e.code === 'number') return `npx exited with code ${e.code}`;
  if (typeof e.code === 'string') return e.code;
  return e.message ?? 'unknown error';
}

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
      timeout: SKILL_INSTALL_TIMEOUT_MS,
    });
    if (!json) clack.log.success('InsForge agent skills installed.');
  } catch (err) {
    if (!json) {
      clack.log.warn(`Could not install agent skills: ${describeExecError(err)}`);
      clack.log.info('Run `npx skills add insforge/agent-skills` once resolved to see the full output.');
    }
  }

  // Install find-skills from vercel-labs for skill discovery
  try {
    if (!json) clack.log.info('Installing find-skills...');
    await execAsync('npx skills add https://github.com/vercel-labs/skills --skill find-skills -y', {
      cwd: process.cwd(),
      timeout: SKILL_INSTALL_TIMEOUT_MS,
    });
    if (!json) clack.log.success('find-skills installed.');
  } catch (err) {
    if (!json) {
      clack.log.warn(`Could not install find-skills: ${describeExecError(err)}`);
      clack.log.info('Run `npx skills add https://github.com/vercel-labs/skills --skill find-skills` once resolved.');
    }
  }

  try {
    updateGitignore();
  } catch {
    // non-critical, silently ignore
  }
}

export async function reportCliUsage(
  toolName: string,
  success: boolean,
  maxRetries = 1,
  explicitConfig?: { oss_host: string; api_key: string },
): Promise<void> {
  let config: { oss_host: string; api_key: string } | null | undefined = explicitConfig;
  if (!config) {
    try {
      config = getProjectConfig();
    } catch {
      return;
    }
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
