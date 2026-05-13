import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAiSetup, ensureLocalEnvIgnored } from './setup.js';

vi.mock('../../lib/api/ai.js', () => ({
  getOpenRouterApiKey: vi.fn(async () => ({
    apiKey: 'sk-or-secret',
    maskedKey: 'sk-or-****cret',
  })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'demo',
    org_id: 'o1',
    appkey: 'app',
    region: 'us-east',
    api_key: 'ik_test',
    oss_host: 'https://app.us-east.insforge.app',
  })),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

let dir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'cli-ai-setup-'));
  process.chdir(dir);
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('runAiSetup', () => {
  it('writes OPENROUTER_API_KEY to .env.local and ignores local env files', async () => {
    const result = await runAiSetup({ json: true });

    expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(
      'OPENROUTER_API_KEY=sk-or-secret\n',
    );
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('.env*.local');
    expect(result).toEqual({
      envFile: '.env.local',
      added: ['OPENROUTER_API_KEY'],
      skipped: [],
      mismatched: [],
      gitignoreUpdated: true,
      maskedKey: 'sk-or-****cret',
    });
  });

  it('does not return the raw key in the setup result', async () => {
    const result = await runAiSetup({ json: true });
    expect(JSON.stringify(result)).not.toContain('sk-or-secret');
  });

  it('does not overwrite an existing different OpenRouter key', async () => {
    writeFileSync(join(dir, '.env.local'), 'OPENROUTER_API_KEY=sk-or-existing\n');

    const result = await runAiSetup({ json: true });

    expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(
      'OPENROUTER_API_KEY=sk-or-existing\n',
    );
    expect(result.added).toEqual([]);
    expect(result.mismatched).toEqual(['OPENROUTER_API_KEY']);
  });

  it('skips an existing matching OpenRouter key', async () => {
    writeFileSync(join(dir, '.env.local'), 'OPENROUTER_API_KEY=sk-or-secret\n');

    const result = await runAiSetup({ json: true });

    expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(
      'OPENROUTER_API_KEY=sk-or-secret\n',
    );
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(['OPENROUTER_API_KEY']);
  });

  it('respects --env-file paths and does not add non-local env files to gitignore', async () => {
    const result = await runAiSetup({ json: true, envFile: '.env' });

    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(
      'OPENROUTER_API_KEY=sk-or-secret\n',
    );
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    expect(result.envFile).toBe('.env');
    expect(result.gitignoreUpdated).toBe(false);
  });
});

describe('ensureLocalEnvIgnored', () => {
  it('does not add .env*.local when .env* is already ignored', () => {
    writeFileSync(join(dir, '.gitignore'), '.env*\n');
    expect(ensureLocalEnvIgnored(dir, '.env.local')).toBe(false);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('.env*\n');
  });

  it('adds .env*.local for non-default local env files when only .env.local is ignored', () => {
    writeFileSync(join(dir, '.gitignore'), '.env.local\n');
    expect(ensureLocalEnvIgnored(dir, '.env.staging.local')).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(
      '.env.local\n\n# Local environment secrets\n.env*.local\n',
    );
  });

  it('does not update gitignore for env files outside the project', () => {
    expect(ensureLocalEnvIgnored(dir, join(tmpdir(), '.env.local'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });
});
