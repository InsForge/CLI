// CLI/src/lib/config-toml.ts
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

export function stringifyConfigToml(config: InsforgeConfig): string {
  // Build sections in deterministic order. smol-toml stringify doesn't
  // guarantee section ordering, so we assemble the file ourselves.
  const lines: string[] = [];

  if (config.project_id !== undefined) {
    lines.push(`project_id = ${JSON.stringify(config.project_id)}`);
    lines.push('');
  }

  if (config.auth) {
    lines.push('[auth]');
    if (config.auth.additional_redirect_urls !== undefined) {
      const urls = config.auth.additional_redirect_urls.map((u) => JSON.stringify(u)).join(', ');
      lines.push(`additional_redirect_urls = [${urls}]`);
    }
    lines.push('');
  }

  if (config.storage?.buckets) {
    const names = Object.keys(config.storage.buckets).sort();
    for (const name of names) {
      const b = config.storage.buckets[name];
      lines.push(`[storage.buckets.${name}]`);
      if (b.public !== undefined) lines.push(`public = ${b.public}`);
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}
