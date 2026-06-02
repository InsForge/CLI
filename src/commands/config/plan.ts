// CLI/src/commands/config/plan.ts
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import pc from 'picocolors';
import { parseConfigToml } from '../../lib/config-toml.js';
import { diffConfig } from '../../lib/config-diff.js';
import { formatPlan } from '../../lib/config-format.js';
import { metadataSupports, changePath } from '../../lib/config-capabilities.js';
import {
  liveFromMetadata,
  type EndpointConfigResponses,
  type RawMetadataResponse,
  type RawRetentionConfig,
  type RawStorageConfig,
} from '../../lib/config-metadata.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackConfig, shutdownAnalytics } from '../../lib/analytics.js';
import { getProjectConfig } from '../../lib/config.js';

export function registerConfigPlanCommand(cfg: Command): void {
  cfg
    .command('plan')
    .description('Show diff between insforge.toml and live project state')
    .option('--file <path>', 'path to insforge.toml', 'insforge.toml')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      let projectConfig: ReturnType<typeof getProjectConfig> = null;
      try {
        projectConfig = getProjectConfig();
        await requireAuth();

        const tomlPath = resolve(process.cwd(), opts.file);
        const tomlSource = readFileSync(tomlPath, 'utf8');
        const file = parseConfigToml(tomlSource);

        const res = await ossFetch('/api/metadata');
        const raw = (await res.json()) as RawMetadataResponse;
        const endpointConfig: EndpointConfigResponses = {};
        if (file.storage !== undefined) {
          endpointConfig.storageConfig = await fetchOptionalConfig<RawStorageConfig>(
            '/api/storage/config',
          );
        }
        if (file.realtime !== undefined) {
          endpointConfig.realtimeConfig = await fetchOptionalConfig<RawRetentionConfig>(
            '/api/realtime/config',
          );
        }
        if (file.schedules !== undefined) {
          endpointConfig.schedulesConfig = await fetchOptionalConfig<RawRetentionConfig>(
            '/api/schedules/config',
          );
        }
        const live = liveFromMetadata(raw, endpointConfig);

        const result = diffConfig({ live, file });

        // Tag each change with whether the backend supports it. Apply will
        // skip unsupported changes; plan surfaces this up front so the user
        // isn't surprised.
        const skipped = result.changes
          .filter((c) => !metadataSupports(raw, c, endpointConfig))
          .map((c) => changePath(c));

        if (json) {
          console.log(JSON.stringify({ ...result, skipped }, null, 2));
        } else {
          console.log(`Plan for insforge.toml (file: ${opts.file}):\n`);
          console.log(formatPlan(result));
          if (skipped.length) {
            console.warn(
              '\n' +
                pc.yellow(`⚠ Apply will skip ${skipped.length} section(s) — backend doesn't support them yet:`) +
                '\n' +
                skipped.map((k) => `  - ${k}`).join('\n'),
            );
          }
        }
        await reportCliUsage('cli.config.plan', true);
        trackConfig('plan', projectConfig, {
          json_mode: !!json,
          changes_count: result.changes.length,
          skipped_count: skipped.length,
          sections_changed: Array.from(
            new Set(result.changes.map((c) => changePath(c))),
          ),
          outcome: 'success',
        });
      } catch (err) {
        await reportCliUsage('cli.config.plan', false);
        trackConfig('plan', projectConfig, {
          json_mode: !!json,
          outcome: 'error',
        });
        await shutdownAnalytics();
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}

async function fetchOptionalConfig<T>(path: string): Promise<T | undefined> {
  try {
    const res = await ossFetch(path);
    return (await res.json()) as T;
  } catch (err) {
    if (isMissingOptionalEndpoint(err)) return undefined;
    throw err;
  }
}

function isMissingOptionalEndpoint(err: unknown): boolean {
  return (
    err instanceof CLIError &&
    err.statusCode === 404 &&
    (err.code === undefined || err.code === 'NOT_FOUND')
  );
}
