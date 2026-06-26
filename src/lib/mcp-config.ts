import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { ProjectConfig } from '../types.js';
import { CLIError } from './errors.js';

export const MCP_SERVER_NAME = 'insforge';

export const MCP_PROVIDERS = [
  'cursor',
  'claude-code',
  'windsurf',
  'cline',
  'roo',
  'codex',
  'antigravity',
] as const;

export type McpProvider = typeof MCP_PROVIDERS[number];

interface ProviderConfig {
  path: string;
}

const PROVIDER_CONFIGS: Record<McpProvider, ProviderConfig> = {
  cursor: { path: '.cursor/mcp.json' },
  'claude-code': { path: '.mcp.json' },
  windsurf: { path: '.windsurf/mcp_config.json' },
  cline: { path: '.cline/mcp.json' },
  roo: { path: '.roo/mcp.json' },
  codex: { path: '.codex/mcp.json' },
  antigravity: { path: '.antigravity/mcp.json' },
};

type JsonObject = Record<string, unknown>;

export interface McpConfigUpdateResult {
  provider: McpProvider;
  path: string;
  serverName: typeof MCP_SERVER_NAME;
  changed: boolean;
}

export function parseMcpProvider(value: string): McpProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude') return 'claude-code';
  if (MCP_PROVIDERS.includes(normalized as McpProvider)) {
    return normalized as McpProvider;
  }
  throw new CLIError(`Invalid MCP provider "${value}". Valid: ${MCP_PROVIDERS.join(', ')}`);
}

export function getMcpConfigPath(provider: McpProvider, cwd = process.cwd()): string {
  return resolve(cwd, PROVIDER_CONFIGS[provider].path);
}

export function displayMcpConfigPath(path: string, cwd = process.cwd()): string {
  const rel = relative(cwd, path);
  if (!rel || rel.startsWith('..')) return path;
  return rel;
}

export function connectMcpProvider(
  provider: McpProvider,
  project: ProjectConfig | { apiKey: string; apiBaseUrl: string },
  cwd = process.cwd()
): McpConfigUpdateResult {
  const path = getMcpConfigPath(provider, cwd);
  const config = readMcpJson(path);
  const existingServers = isObject(config.mcpServers) ? config.mcpServers : {};
  const server = buildMcpServerConfig(project);
  const changed = JSON.stringify(existingServers[MCP_SERVER_NAME]) !== JSON.stringify(server);

  config.mcpServers = {
    ...existingServers,
    [MCP_SERVER_NAME]: server,
  };
  writeMcpJson(path, config);

  return {
    provider,
    path,
    serverName: MCP_SERVER_NAME,
    changed,
  };
}

export function disconnectMcpProvider(provider: McpProvider, cwd = process.cwd()): McpConfigUpdateResult {
  const path = getMcpConfigPath(provider, cwd);
  const config = readMcpJson(path);
  const existingServers = isObject(config.mcpServers) ? config.mcpServers : {};
  const changed = Object.prototype.hasOwnProperty.call(existingServers, MCP_SERVER_NAME);

  if (changed) {
    const nextServers = { ...existingServers };
    delete nextServers[MCP_SERVER_NAME];
    config.mcpServers = nextServers;
    writeMcpJson(path, config);
  }

  return {
    provider,
    path,
    serverName: MCP_SERVER_NAME,
    changed,
  };
}

function buildMcpServerConfig(config: ProjectConfig | { apiKey: string; apiBaseUrl: string }): JsonObject {
  const host = 'oss_host' in config ? config.oss_host : config.apiBaseUrl;
  const key = 'api_key' in config ? config.api_key : config.apiKey;
  return {
    type: 'http',
    url: `${host.replace(/\/$/, '')}/api/usage/mcp`,
    headers: {
      Authorization: `Bearer ${key}`,
      'x-api-key': key,
    },
  };
}

function readMcpJson(path: string): JsonObject {
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      throw new CLIError(`${displayMcpConfigPath(path)} must contain a JSON object.`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof CLIError) throw err;
    throw new CLIError(`Could not parse ${displayMcpConfigPath(path)} as JSON.`);
  }
}

function writeMcpJson(path: string, config: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
