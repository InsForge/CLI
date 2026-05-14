// CLI/src/commands/config/plan.ts
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import pc from 'picocolors';
import { parseConfigToml } from '../../lib/config-toml.js';
import { diffConfig } from '../../lib/config-diff.js';
import { formatPlan } from '../../lib/config-format.js';
import { metadataSupports, changePath } from '../../lib/config-capabilities.js';
import { liveFromMetadata, type RawMetadataResponse } from '../../lib/config-metadata.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerConfigPlanCommand(cfg: Command): void {
  cfg
    .command('plan')
    .description('Show diff between insforge.toml and live project state')
    .option('--file <path>', 'path to insforge.toml', 'insforge.toml')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const tomlPath = resolve(process.cwd(), opts.file);
        const tomlSource = readFileSync(tomlPath, 'utf8');
        const file = parseConfigToml(tomlSource);

        const res = await ossFetch('/api/metadata');
        const raw = (await res.json()) as RawMetadataResponse;
        const live = liveFromMetadata(raw);

        const result = diffConfig({ live, file });

        // Tag each change with whether the backend supports it. Apply will
        // skip unsupported changes; plan surfaces this up front so the user
        // isn't surprised.
        const skipped = result.changes
          .filter((c) => !metadataSupports(raw, c))
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
      } catch (err) {
        await reportCliUsage('cli.config.plan', false);
        handleError(err, json);
      }
    });
}
