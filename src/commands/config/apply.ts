// CLI/src/commands/config/apply.ts
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { parseConfigToml } from '../../lib/config-toml.js';
import { diffConfig, type DiffChange, type LiveConfig } from '../../lib/config-diff.js';
import { formatPlan } from '../../lib/config-format.js';
import { metadataSupports, changePath } from '../../lib/config-capabilities.js';
import { resolveEnvRef } from '../../lib/config-secrets.js';
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

export function registerConfigApplyCommand(cfg: Command): void {
  cfg
    .command('apply')
    .description('Apply insforge.toml to the live project')
    .option('--file <path>', 'path to insforge.toml', 'insforge.toml')
    .option('--dry-run', 'show plan, do not apply')
    .option('--auto-approve', 'skip confirmation prompt')
    .action(async (opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();

        const tomlPath = resolve(process.cwd(), opts.file);
        const tomlSource = readFileSync(tomlPath, 'utf8');
        const file = parseConfigToml(tomlSource);

        const res = await ossFetch('/api/metadata');
        const raw = (await res.json()) as RawMetadataResponse;
        const live = liveFromMetadata(raw);

        const result = diffConfig({ live, file });
        const approved = opts.autoApprove || yes;

        // Render the plan immediately in interactive mode so the user can read
        // it before confirming. In --json mode hold output until the end so
        // we emit a single JSON document (parsable by jq, etc.).
        if (!json) {
          console.log(formatPlan(result));
        }

        if (result.changes.length === 0 || opts.dryRun) {
          if (json) {
            console.log(
              JSON.stringify({ plan: result, applied: false, dryRun: !!opts.dryRun }, null, 2),
            );
          }
          await reportCliUsage('cli.config.apply', true);
          return;
        }

        if (!approved) {
          if (json) {
            // No TTY in --json runs; require explicit consent rather than
            // silently applying or hanging on a prompt.
            throw new CLIError(
              'Refusing to apply in --json mode without --auto-approve or --yes.',
              1,
              'CONFIRMATION_REQUIRED',
            );
          }
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

        // Per-change capability gate. Each change is independent: a backend
        // that supports `auth.allowed_redirect_urls` but not `auth.smtp`
        // should apply the first and skip the second with a named warning.
        // Better than failing the whole batch.
        const applied: DiffChange[] = [];
        const skipped: Array<{ key: string; reason: string }> = [];
        for (const change of result.changes) {
          const path = changePath(change);
          if (!metadataSupports(raw, change)) {
            skipped.push({
              key: path,
              reason: `your backend doesn't expose ${path} — upgrade the project to apply this section`,
            });
            continue;
          }
          await applyChange(change);
          applied.push(change);
        }

        if (json) {
          console.log(
            JSON.stringify({ plan: result, applied, skipped }, null, 2),
          );
        } else {
          if (skipped.length) {
            console.warn(
              pc.yellow(`⚠ Skipped ${skipped.length} section(s):`) +
                '\n' +
                skipped.map((s) => `  - ${s.key}: ${s.reason}`).join('\n'),
            );
          }
          if (applied.length) {
            console.log(
              `${pc.green('✓')} Applied ${applied.length} of ${result.changes.length} change(s).`,
            );
          } else {
            console.log('Nothing applied.');
          }
        }
        await reportCliUsage('cli.config.apply', true);
      } catch (err) {
        await reportCliUsage('cli.config.apply', false);
        handleError(err, json);
      }
    });
}

function liveFromMetadata(raw: RawMetadataResponse): LiveConfig {
  const live: LiveConfig = { auth: {} };
  if (raw.auth?.allowedRedirectUrls !== undefined) {
    live.auth!.allowed_redirect_urls = raw.auth.allowedRedirectUrls;
  }
  if (raw.auth?.smtpConfig) {
    const s = raw.auth.smtpConfig;
    live.auth!.smtp = {
      enabled: s.enabled ?? false,
      host: s.host ?? '',
      port: s.port ?? 587,
      username: s.username ?? '',
      hasPassword: s.hasPassword ?? false,
      sender_email: s.senderEmail ?? '',
      sender_name: s.senderName ?? '',
      min_interval_seconds: s.minIntervalSeconds ?? 60,
    };
  }
  return live;
}

async function applyChange(change: DiffChange): Promise<void> {
  if (change.section === 'auth' && change.key === 'allowed_redirect_urls') {
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ allowedRedirectUrls: change.to }),
    });
    return;
  }
  if (change.section === 'auth.smtp') {
    // Build the upsert body from the file's resolved view. Force-resend the
    // password every time when an env() ref is present — see config-diff.ts
    // for the rationale.
    const to = change.to;
    const body: Record<string, unknown> = {
      enabled: to.enabled,
      host: to.host,
      port: to.port,
      username: to.username,
      senderEmail: to.sender_email,
      senderName: to.sender_name,
      minIntervalSeconds: to.min_interval_seconds,
    };
    if (change.passwordEnvRef) {
      // Pre-flight resolves the secret; failure here aborts BEFORE we PUT
      // anything, so a missing secret doesn't leave the backend half-updated.
      const value = await resolveEnvRef(
        `env(${change.passwordEnvRef})`,
        'auth.smtp.password',
      );
      body.password = value;
    }
    // Omitting `password` from the body tells the backend's upsert to
    // preserve the existing encrypted value — matches our "absent = preserve"
    // semantics. Force-resend only fires when the TOML carries an env() ref.
    await ossFetch('/api/auth/smtp-config', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return;
  }
  // Exhaustiveness check — TS will error if we miss a discriminated variant.
  const _exhaustive: never = change;
  throw new Error(`Unsupported change: ${JSON.stringify(_exhaustive)}`);
}
