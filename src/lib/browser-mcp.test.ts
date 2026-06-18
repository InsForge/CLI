import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCodexToml, mergeJsonMcp } from './browser-mcp.js';

const HEADLESS_SERVER = {
  command: 'npx',
  args: ['@playwright/mcp@latest', '--headless'],
};

describe('mergeJsonMcp', () => {
  let dir: string;
  let file: string;
  const read = () => JSON.parse(readFileSync(file, 'utf-8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'insforge-mcp-'));
    file = join(dir, '.cursor', 'mcp.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file (and parent dirs) with the server under mcpServers', () => {
    expect(mergeJsonMcp(file, 'mcpServers', HEADLESS_SERVER)).toBe(true);
    expect(read().mcpServers['playwright']).toEqual(HEADLESS_SERVER);
  });

  it('merges without clobbering other servers', () => {
    writeFileSync(join(dir, 'cfg.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    expect(mergeJsonMcp(join(dir, 'cfg.json'), 'mcpServers', HEADLESS_SERVER)).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, 'cfg.json'), 'utf-8'));
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers['playwright']).toBeDefined();
  });

  it('is idempotent — returns false when already present and identical', () => {
    mergeJsonMcp(file, 'mcpServers', HEADLESS_SERVER);
    expect(mergeJsonMcp(file, 'mcpServers', HEADLESS_SERVER)).toBe(false);
  });

  it('recovers from malformed JSON by starting fresh', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json');
    expect(mergeJsonMcp(bad, 'mcpServers', HEADLESS_SERVER)).toBe(true);
    expect(JSON.parse(readFileSync(bad, 'utf-8')).mcpServers['playwright']).toBeDefined();
  });

  it('supports the VS Code `servers` key', () => {
    expect(mergeJsonMcp(file, 'servers', HEADLESS_SERVER)).toBe(true);
    expect(read().servers['playwright']).toEqual(HEADLESS_SERVER);
  });
});

describe('ensureCodexToml', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'insforge-codex-'));
    file = join(dir, '.codex', 'config.toml');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a [mcp_servers.playwright] block when absent', () => {
    expect(ensureCodexToml(file)).toBe(true);
    const toml = readFileSync(file, 'utf-8');
    expect(toml).toContain('[mcp_servers.playwright]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('"--headless"');
  });

  it('is idempotent — returns false when the block already exists', () => {
    ensureCodexToml(file);
    expect(ensureCodexToml(file)).toBe(false);
  });

  it('preserves existing TOML content', () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '[some_other_section]\nkey = "value"\n');
    expect(ensureCodexToml(file)).toBe(true);
    const toml = readFileSync(file, 'utf-8');
    expect(toml).toContain('[some_other_section]');
    expect(toml).toContain('[mcp_servers.playwright]');
  });
});
