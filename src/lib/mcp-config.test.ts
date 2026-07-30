import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectMcpProvider,
  disconnectMcpProvider,
  getMcpConfigPath,
  parseMcpProvider,
} from './mcp-config.js';
import type { ProjectConfig } from '../types.js';

const project: ProjectConfig = {
  project_id: 'p1',
  project_name: 'demo',
  org_id: 'o1',
  appkey: 'app',
  region: 'us',
  api_key: 'secret',
  oss_host: 'https://app.us.insforge.app',
};

let dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'insforge-mcp-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe('mcp config helpers', () => {
  it('writes an insforge MCP server while preserving existing entries', () => {
    const cwd = tempDir();
    const path = getMcpConfigPath('cursor', cwd);
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'node' } } }));

    const result = connectMcpProvider('cursor', project, cwd);
    const config = JSON.parse(readFileSync(path, 'utf-8'));

    expect(result.changed).toBe(true);
    expect(config.mcpServers.other).toEqual({ command: 'node' });
    expect(config.mcpServers.insforge).toMatchObject({
      type: 'http',
      url: 'https://app.us.insforge.app/api/usage/mcp',
      headers: {
        Authorization: 'Bearer secret',
        'x-api-key': 'secret',
      },
    });
  });

  it('removes only the insforge MCP server', () => {
    const cwd = tempDir();
    connectMcpProvider('claude-code', project, cwd);

    const result = disconnectMcpProvider('claude-code', cwd);
    const config = JSON.parse(readFileSync(getMcpConfigPath('claude-code', cwd), 'utf-8'));

    expect(result.changed).toBe(true);
    expect(config.mcpServers.insforge).toBeUndefined();
  });

  it('accepts claude as an alias for claude-code', () => {
    expect(parseMcpProvider('claude')).toBe('claude-code');
  });
});
