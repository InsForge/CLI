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
import type { InsforgeConfig } from '../../lib/config-schema.js';
import { reportCliUsage } from '../../lib/skills.js';

interface RawAuthMetadata {
  allowedRedirectUrls?: string[];
  smtpConfig?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    username?: string;
    hasPassword?: boolean;
    senderEmail?: string;
    senderName?: string;
    minIntervalSeconds?: number;
  };
}

interface RawMetadataResponse {
  auth?: RawAuthMetadata;
}

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

        // Only emit sections the backend actually exposes. The TOML file
        // should describe what THIS backend can do — not aspirational fields
        // that would break on apply. Probe presence in the raw response;
        // an older backend without the field gets an empty config,
        // not a TOML littered with defaults that pretend to work.
        const config: InsforgeConfig = {};
        const skipped: string[] = [];

        const authSlice = raw?.auth;
        if (authSlice && typeof authSlice === 'object' && 'allowedRedirectUrls' in authSlice) {
          config.auth = config.auth ?? {};
          config.auth.allowed_redirect_urls = authSlice.allowedRedirectUrls ?? [];
        } else {
          skipped.push('auth.allowed_redirect_urls');
        }

        if (
          authSlice &&
          typeof authSlice === 'object' &&
          'smtpConfig' in authSlice &&
          authSlice.smtpConfig
        ) {
          const s = authSlice.smtpConfig;
          config.auth = config.auth ?? {};
          config.auth.smtp = {
            enabled: s.enabled ?? false,
            host: s.host ?? '',
            port: s.port ?? 587,
            username: s.username ?? '',
            // When backend has a password set, emit a deterministic env()
            // placeholder so the user knows which secret to define. We do
            // NOT round-trip the value (it never leaves the backend).
            // Re-applying this TOML force-resends from the secrets store
            // — see config-diff.ts for the force-resend rationale.
            ...(s.hasPassword ? { password: 'env(SMTP_PASSWORD)' } : {}),
            sender_email: s.senderEmail ?? '',
            sender_name: s.senderName ?? '',
            min_interval_seconds: s.minIntervalSeconds ?? 60,
          };
        } else {
          skipped.push('auth.smtp');
        }

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
