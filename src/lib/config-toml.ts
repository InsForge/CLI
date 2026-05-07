import * as smolToml from 'smol-toml';
import { validateConfig, type InsforgeConfig } from './config-schema.js';

export function parseConfigToml(input: string): InsforgeConfig {
  let parsed: unknown;
  try {
    parsed = smolToml.parse(input);
  } catch (err) {
    throw new Error(`TOML parse error: ${(err as Error).message}`);
  }
  return validateConfig(parsed);
}

/**
 * Render a normalized config back to TOML. Section ordering is deterministic
 * (project_id → auth) so diffs are stable across runs of `insforge config export`.
 */
export function stringifyConfigToml(config: InsforgeConfig): string {
  const lines: string[] = [];

  if (config.project_id !== undefined) {
    lines.push(`project_id = ${JSON.stringify(config.project_id)}`);
    lines.push('');
  }

  if (config.auth) {
    lines.push('[auth]');
    if (config.auth.allowed_redirect_urls !== undefined) {
      const urls = config.auth.allowed_redirect_urls
        .map((u) => JSON.stringify(u))
        .join(', ');
      lines.push(`allowed_redirect_urls = [${urls}]`);
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}
