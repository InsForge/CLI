import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GlobalConfig, ProjectConfig, StoredCredentials } from '../types.js';

const GLOBAL_DIR = join(homedir(), '.insforge');
const CREDENTIALS_FILE = join(GLOBAL_DIR, 'credentials.json');
const CONFIG_FILE = join(GLOBAL_DIR, 'config.json');

const DEFAULT_PLATFORM_URL = 'https://api.insforge.dev';
const DEFAULT_FRONTEND_URL = 'https://app.insforge.dev';

function ensureGlobalDir(): void {
  if (!existsSync(GLOBAL_DIR)) {
    mkdirSync(GLOBAL_DIR, { recursive: true });
  }
}

// --- Global Config ---

export function getGlobalConfig(): GlobalConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { platform_api_url: DEFAULT_PLATFORM_URL };
  }
  const raw = readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw);
}

export function saveGlobalConfig(config: GlobalConfig): void {
  ensureGlobalDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// --- Credentials ---

export function getCredentials(): StoredCredentials | null {
  if (!existsSync(CREDENTIALS_FILE)) {
    return null;
  }
  const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
  return JSON.parse(raw);
}

export function saveCredentials(creds: StoredCredentials): void {
  ensureGlobalDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    unlinkSync(CREDENTIALS_FILE);
  }
  // Clear session-related config (default_org_id) but keep platform_api_url etc.
  const config = getGlobalConfig();
  if (config.default_org_id) {
    delete config.default_org_id;
    saveGlobalConfig(config);
  }
}

// --- Project Config (local) ---

function getLocalConfigDir(): string {
  return join(process.cwd(), '.insforge');
}

function getLocalConfigFile(): string {
  return join(getLocalConfigDir(), 'project.json');
}

export function getProjectConfig(): ProjectConfig | null {
  const file = getLocalConfigFile();
  if (!existsSync(file)) {
    return null;
  }
  const raw = readFileSync(file, 'utf-8');
  return JSON.parse(raw);
}

export function saveProjectConfig(config: ProjectConfig): void {
  const dir = getLocalConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getLocalConfigFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

// --- Resolved values (env vars > flags > config) ---

export function getPlatformApiUrl(override?: string): string {
  return process.env.INSFORGE_API_URL ?? override ?? getGlobalConfig().platform_api_url ?? DEFAULT_PLATFORM_URL;
}

export function getFrontendUrl(): string {
  return process.env.INSFORGE_FRONTEND_URL ?? DEFAULT_FRONTEND_URL;
}

export function getAccessToken(): string | null {
  return process.env.INSFORGE_ACCESS_TOKEN ?? getCredentials()?.access_token ?? null;
}

export function getProjectId(override?: string): string | null {
  return process.env.INSFORGE_PROJECT_ID ?? override ?? getProjectConfig()?.project_id ?? null;
}
