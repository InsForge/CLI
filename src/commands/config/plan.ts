// CLI/src/commands/config/plan.ts
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { parseConfigToml } from '../../lib/config-toml.js';
import { diffConfig } from '../../lib/config-diff.js';
import { formatPlan } from '../../lib/config-format.js';
import { validateConfig } from '../../lib/config-schema.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerConfigPlanCommand(cfg: Command): void {
  cfg
    .command('plan')
    .description('Show diff between insforge.toml and live project state')
    .option('--file <path>', 'path to insforge.toml', 'insforge.toml')
    .option('--prune', 'mark DB-only items as removals (default: keep)')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const tomlPath = resolve(process.cwd(), opts.file);
        const tomlSource = readFileSync(tomlPath, 'utf8');
        const file = parseConfigToml(tomlSource);

        const res = await ossFetch('/api/config');
        const raw = (await res.json()) as { config: unknown };
        const live = validateConfig(raw.config);

        const result = diffConfig({ live, file, prune: !!opts.prune });

        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Plan for insforge.toml (file: ${opts.file}):\n`);
          console.log(formatPlan(result));
        }
        await reportCliUsage('cli.config.plan', true);
      } catch (err) {
        await reportCliUsage('cli.config.plan', false);
        handleError(err, json);
      }
    });
}
