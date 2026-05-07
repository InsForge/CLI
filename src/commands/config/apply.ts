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
import { diffConfig, type DiffChange } from '../../lib/config-diff.js';
import { formatPlan } from '../../lib/config-format.js';
import type { InsforgeConfig } from '../../lib/config-schema.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerConfigApplyCommand(cfg: Command): void {
  cfg
    .command('apply')
    .description('Apply insforge.toml to the live project')
    .option('--file <path>', 'path to insforge.toml', 'insforge.toml')
    .option('--dry-run', 'show plan, do not apply')
    .option('--auto-approve', 'skip confirmation prompt')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const tomlPath = resolve(process.cwd(), opts.file);
        const tomlSource = readFileSync(tomlPath, 'utf8');
        const file = parseConfigToml(tomlSource);

        const res = await ossFetch('/api/metadata');
        const raw = (await res.json()) as {
          auth?: { allowedRedirectUrls?: string[] };
        };
        const live: InsforgeConfig = {
          auth: { allowed_redirect_urls: raw.auth?.allowedRedirectUrls ?? [] },
        };

        const result = diffConfig({ live, file });

        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatPlan(result));
        }

        if (result.changes.length === 0 || opts.dryRun) {
          await reportCliUsage('cli.config.apply', true);
          return;
        }

        if (!opts.autoApprove && !json) {
          const ok = await p.confirm({
            message: 'Apply these changes?',
            initialValue: false,
          });
          if (!ok || p.isCancel(ok)) {
            console.log('Aborted.');
            await reportCliUsage('cli.config.apply', true);
            return;
          }
        }

        for (const change of result.changes) {
          await applyChange(change, file);
        }

        if (json) {
          console.log(JSON.stringify({ applied: true, changes: result.changes }));
        } else {
          const s = result.summary;
          console.log(
            `${pc.green('✓')} Applied (${s.add} added, ${s.modify} modified, ${s.remove} removed)`,
          );
        }
        await reportCliUsage('cli.config.apply', true);
      } catch (err) {
        await reportCliUsage('cli.config.apply', false);
        handleError(err, json);
      }
    });
}

async function applyChange(
  change: DiffChange,
  file: InsforgeConfig,
): Promise<void> {
  if (change.section === 'auth' && change.key === 'allowed_redirect_urls') {
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ allowedRedirectUrls: change.to }),
    });
    return;
  }
  throw new Error(`Unsupported change type: ${change.section}.${change.key}`);
}
