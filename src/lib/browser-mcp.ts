import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const MCP_CONFIG_TIMEOUT_MS = 60_000;

// `@playwright/mcp` is the browser-automation MCP (browser_navigate/click/snapshot +
// console/network tools) the light-mode `insforge-verify` skill drives directly — NOT
// `run-test-mcp-server`, which is the Test Agents (planner/generator) pipeline and has no
// browser_* tools.
const MCP_SERVER_NAME = 'playwright';
const MCP_COMMAND = 'npx';
const MCP_ARGS = ['@playwright/mcp@latest', '--headless'];

/**
 * Merge the Playwright MCP server into a JSON MCP config (user/global scope),
 * returning true if it changed the file. `key` is the top-level object servers live
 * under — `mcpServers` for Cursor/Windsurf/Gemini, `servers` for VS Code. Malformed
 * JSON is replaced rather than crashing the link.
 */
export function mergeJsonMcp(
  file: string,
  key: 'mcpServers' | 'servers',
  server: Record<string, unknown>,
): boolean {
  let config: Record<string, Record<string, unknown>> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as typeof config;
      }
    } catch {
      config = {};
    }
  }
  config[key] ??= {};
  if (JSON.stringify(config[key][MCP_SERVER_NAME]) === JSON.stringify(server)) return false;
  config[key][MCP_SERVER_NAME] = server;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/** Append a `[mcp_servers.playwright]` block to Codex's global TOML config if absent. */
export function ensureCodexToml(file: string): boolean {
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  if (existing.includes(`[mcp_servers.${MCP_SERVER_NAME}]`)) return false;
  const args = MCP_ARGS.map((a) => `"${a}"`).join(', ');
  const block = `\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${MCP_COMMAND}"\nargs = [${args}]\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, existing + block);
  return true;
}

async function commandExists(cmd: string): Promise<boolean> {
  return execAsync(`command -v ${cmd}`).then(
    () => true,
    () => false,
  );
}

/**
 * One agent's recipe for registering the browser MCP at user/global scope — mirroring
 * how `skills add -a <agent> -g` delegates skill placement per agent. `apply` returns a
 * label of what it configured, or null if the agent isn't present (skip it). Add an
 * agent by adding one entry — no other call site changes (cf. AGENT_FLAGS).
 */
interface BrowserMcpTarget {
  agent: string;
  apply: (home: string) => Promise<string | null>;
}

const JSON_MCP_SERVER = { command: MCP_COMMAND, args: MCP_ARGS };

const BROWSER_MCP_TARGETS: BrowserMcpTarget[] = [
  {
    // Claude Code: delegate to its own CLI at user scope (global across projects),
    // exactly like the skills install delegates placement. Idempotent + quiet on repeat
    // links: skip if already configured. Skipped if the `claude` CLI isn't on PATH.
    agent: 'Claude Code',
    apply: async () => {
      if (!(await commandExists('claude'))) return null;
      const present = await execAsync(`claude mcp get ${MCP_SERVER_NAME}`)
        .then(() => true)
        .catch(() => false);
      if (present) return null;
      await execAsync(
        `claude mcp add ${MCP_SERVER_NAME} -s user -- ${MCP_COMMAND} ${MCP_ARGS.join(' ')}`,
        { timeout: MCP_CONFIG_TIMEOUT_MS },
      );
      return 'user scope';
    },
  },
  {
    // Cursor: no CLI — write its global config file, only if Cursor is set up.
    agent: 'Cursor',
    apply: async (home) => {
      if (!existsSync(join(home, '.cursor'))) return null;
      return mergeJsonMcp(join(home, '.cursor', 'mcp.json'), 'mcpServers', JSON_MCP_SERVER)
        ? '~/.cursor/mcp.json'
        : null;
    },
  },
  {
    // Codex: global TOML, only if Codex is set up.
    agent: 'Codex',
    apply: async (home) => {
      if (!existsSync(join(home, '.codex'))) return null;
      return ensureCodexToml(join(home, '.codex', 'config.toml')) ? '~/.codex/config.toml' : null;
    },
  },
];

/**
 * Configure the Playwright browser MCP at user/global scope for whichever agents
 * are present, so light-mode `insforge-verify` can drive the browser. Global to match
 * how the InsForge skills install (`skills add … -g`); the server command is identical
 * across agents — only where/how it's registered differs. No network beyond each agent's
 * own CLI, no LLM, no subagents (the user's agent is the driving brain). Returns a label
 * per agent configured. Best-effort: one agent failing never blocks the others.
 */
export async function configureBrowserMcp(home = homedir()): Promise<string[]> {
  const configured: string[] = [];
  for (const target of BROWSER_MCP_TARGETS) {
    try {
      const label = await target.apply(home);
      if (label) configured.push(`${target.agent} (${label})`);
    } catch {
      // best-effort per agent
    }
  }
  return configured;
}
