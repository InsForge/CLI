// CLI/src/commands/config/export.ts
import type { Command } from 'commander';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { stringifyConfigToml } from '../../lib/config-toml.js';
import { configFromMetadata, type RawMetadataResponse } from '../../lib/config-metadata.js';
import { reportCliUsage } from '../../lib/skills.js';

export function registerConfigExportCommand(cfg: Command): void {
  cfg
    .command('export')
    .description('Pull live project config and write insforge.toml')
    .option('--out <path>', 'output path', 'insforge.toml')
    .option('--force', 'overwrite without confirmation')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const target = resolve(process.cwd(), opts.out);
        if (existsSync(target) && !opts.force) {
          if (json) {
            // No TTY in --json runs; bail with an actionable error instead
            // of hanging on an interactive prompt.
            throw new CLIError(
              `${opts.out} exists. Re-run with --force to overwrite.`,
              1,
              'OUTPUT_EXISTS',
            );
          }
          const ok = await p.confirm({
            message: `${opts.out} exists. Overwrite?`,
            initialValue: false,
          });
          if (!ok || p.isCancel(ok)) {
            console.log('Aborted.');
            return;
          }
        }

        const res = await ossFetch('/api/metadata');
        const raw = (await res.json()) as RawMetadataResponse;

        // Field detection lives in config-metadata.ts alongside liveFromMetadata
        // so apply/plan/export read the same response the same way. Adding a
        // new field touches one place, not three.
        const { config, skipped } = configFromMetadata(raw);

        const toml = stringifyConfigToml(config);
        writeFileSync(target, toml, 'utf8');

        if (json) {
          console.log(JSON.stringify({ written: target, config, skipped }, null, 2));
        } else {
          console.log(`${pc.green('✓')} Wrote ${target}`);
          if (skipped.length) {
            console.warn(
              pc.yellow(
                `⚠ Skipped ${skipped.length} section(s) not supported by this backend:`,
              ) +
                '\n' +
                skipped.map((k) => `  - ${k}`).join('\n'),
            );
          }
        }
        await reportCliUsage('cli.config.export', true);
      } catch (err) {
        await reportCliUsage('cli.config.export', false);
        handleError(err, json);
      }
    });
}
