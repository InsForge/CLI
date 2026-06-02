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
import { diffConfig, type DiffChange } from '../../lib/config-diff.js';
import { formatPlan } from '../../lib/config-format.js';
import {
  metadataSupports,
  changePath,
  authPasswordWireKey,
} from '../../lib/config-capabilities.js';
import { resolveEnvRef } from '../../lib/config-secrets.js';
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

export function registerConfigApplyCommand(cfg: Command): void {
  cfg
    .command('apply')
    .description('Apply insforge.toml to the live project')
    .option('--file <path>', 'path to insforge.toml', 'insforge.toml')
    .option('--dry-run', 'show plan, do not apply')
    .option('--auto-approve', 'skip confirmation prompt')
    .action(async (opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
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
        const approved = opts.autoApprove || yes;
        const sectionsChanged = Array.from(
          new Set(result.changes.map((c) => changePath(c))),
        );

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
          trackConfig('apply', projectConfig, {
            dry_run: !!opts.dryRun,
            json_mode: !!json,
            changes_count: result.changes.length,
            sections_changed: sectionsChanged,
            outcome: result.changes.length === 0 ? 'no_changes' : 'dry_run',
          });
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
            trackConfig('apply', projectConfig, {
              json_mode: !!json,
              changes_count: result.changes.length,
              sections_changed: sectionsChanged,
              outcome: 'aborted',
            });
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
          if (!metadataSupports(raw, change, endpointConfig)) {
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
        trackConfig('apply', projectConfig, {
          auto_approved: !!approved,
          json_mode: !!json,
          changes_count: result.changes.length,
          applied_count: applied.length,
          skipped_count: skipped.length,
          sections_changed: sectionsChanged,
          outcome: applied.length > 0 ? 'applied' : 'all_skipped',
        });
      } catch (err) {
        await reportCliUsage('cli.config.apply', false);
        trackConfig('apply', projectConfig, {
          json_mode: !!json,
          outcome: 'error',
        });
        // Flush before handleError() calls process.exit(), otherwise the
        // queued event is lost when the event loop terminates.
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

async function applyChange(change: DiffChange): Promise<void> {
  if (change.section === 'auth' && change.key === 'allowed_redirect_urls') {
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ allowedRedirectUrls: change.to }),
    });
    return;
  }
  if (change.section === 'auth' && change.key === 'require_email_verification') {
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ requireEmailVerification: change.to }),
    });
    return;
  }
  if (change.section === 'auth' && change.key === 'verify_email_method') {
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ verifyEmailMethod: change.to }),
    });
    return;
  }
  if (change.section === 'auth' && change.key === 'reset_password_method') {
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ resetPasswordMethod: change.to }),
    });
    return;
  }
  if (change.section === 'auth' && change.key === 'disable_signup') {
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ disableSignup: change.to }),
    });
    return;
  }
  if (change.section === 'auth.password') {
    // Each password policy field is independently dispatched — same endpoint,
    // partial body. The capability gate already confirmed the field exists on
    // this backend; the wire key is centralized in config-capabilities so a
    // future rename touches one place.
    const wireKey = authPasswordWireKey(change.key);
    await ossFetch('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify({ [wireKey]: change.to }),
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
  if (change.section === 'storage' && change.key === 'max_file_size_mb') {
    await ossFetch('/api/storage/config', {
      method: 'PUT',
      body: JSON.stringify({ maxFileSizeMb: change.to }),
    });
    return;
  }
  if (change.section === 'realtime' && change.key === 'retention_days') {
    await ossFetch('/api/realtime/config', {
      method: 'PATCH',
      body: JSON.stringify({ retentionDays: change.to }),
    });
    return;
  }
  if (change.section === 'schedules' && change.key === 'retention_days') {
    await ossFetch('/api/schedules/config', {
      method: 'PATCH',
      body: JSON.stringify({ retentionDays: change.to }),
    });
    return;
  }
  if (change.section === 'deployments' && change.key === 'subdomain') {
    // Backend (updateSlugRequestSchema) accepts string | null; the diff
    // layer already normalized empty-string to null. A conflict on a
    // taken slug returns 409 — ossFetch surfaces that as a CLIError with
    // the backend's "Slug is already taken" message.
    await ossFetch('/api/deployments/slug', {
      method: 'PUT',
      body: JSON.stringify({ slug: change.to }),
    });
    return;
  }
  // Exhaustiveness check — TS will error if we miss a discriminated variant.
  const _exhaustive: never = change;
  throw new Error(`Unsupported change: ${JSON.stringify(_exhaustive)}`);
}
