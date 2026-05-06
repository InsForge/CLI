// CLI/src/commands/config/apply.ts
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { parseConfigToml } from '../../lib/config-toml.js';
import { formatPlan } from '../../lib/config-format.js';
import type { DiffResult } from '../../lib/config-diff.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerConfigApplyCommand(cfg: Command): void {
  cfg
    .command('apply')
    .description('Apply insforge.toml to the live project')
    .option('--file <path>', 'path to insforge.toml', 'insforge.toml')
    .option('--dry-run', 'show plan, do not apply')
    .option('--auto-approve', 'skip confirmation prompt')
    .option('--prune', 'delete items in live state that are missing from the file')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const tomlPath = resolve(process.cwd(), opts.file);
        const tomlSource = readFileSync(tomlPath, 'utf8');
        const file = parseConfigToml(tomlSource);

        // Phase 1: always POST with dry_run=true to get the plan.
        const planRes = await ossFetch('/api/config/apply', {
          method: 'POST',
          body: JSON.stringify({ config: file, dry_run: true, prune: !!opts.prune }),
        });
        const planResult = (await planRes.json()) as { plan: DiffResult; applied: boolean };

        if (json) {
          console.log(JSON.stringify(planResult, null, 2));
        } else {
          console.log(formatPlan(planResult.plan));
        }

        if (planResult.plan.changes.length === 0 || opts.dryRun) {
          await reportCliUsage('cli.config.apply', true);
          return;
        }

        // Phase 2: confirm (unless --auto-approve).
        if (!opts.autoApprove) {
          const ok = await p.confirm({ message: 'Apply these changes?', initialValue: false });
          if (!ok || p.isCancel(ok)) {
            console.log('Aborted.');
            await reportCliUsage('cli.config.apply', true);
            return;
          }
        }

        // Phase 3: POST with dry_run=false to actually apply.
        const applyRes = await ossFetch('/api/config/apply', {
          method: 'POST',
          body: JSON.stringify({ config: file, dry_run: false, prune: !!opts.prune }),
        });
        const applyResult = (await applyRes.json()) as { plan: DiffResult; applied: boolean };

        if (json) {
          console.log(JSON.stringify(applyResult, null, 2));
        } else {
          const s = applyResult.plan.summary;
          console.log(`${pc.green('✓')} Applied (${s.add} added, ${s.modify} modified, ${s.remove} removed)`);
        }
        await reportCliUsage('cli.config.apply', true);
      } catch (err) {
        await reportCliUsage('cli.config.apply', false);
        handleError(err, json);
      }
    });
}
