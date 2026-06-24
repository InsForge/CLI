import type { Command } from 'commander';
import type { AppMetadataSchema } from '@insforge/shared-schemas';
import { ossFetch } from '../lib/api/oss.js';
import { requireAuth } from '../lib/credentials.js';
import { handleError, getRootOpts } from '../lib/errors.js';
import { outputJson, outputTable } from '../lib/output.js';
import { reportCliUsage } from '../lib/skills.js';
import { trackTopLevelUsage } from '../lib/command-telemetry.js';

export function registerMetadataCommand(program: Command): void {
  program
    .command('metadata')
    .description('Show backend metadata (auth, database, buckets, edge functions, realtime, AI models)')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const res = await ossFetch('/api/metadata');
        const data = await res.json() as AppMetadataSchema;

        await trackTopLevelUsage('metadata', true);

        if (json) {
          outputJson(data);
          return;
        }

        // Auth
        console.log('\n  Auth');
        console.log(`    OAuth Providers:   ${data.auth.oAuthProviders.length ? data.auth.oAuthProviders.join(', ') : '(none)'}`);
        console.log(`    Email Verification: ${data.auth.requireEmailVerification ? 'Yes' : 'No'}`);
        console.log(`    Password Policy:`);
        console.log(`      Min Length: ${data.auth.passwordMinLength}, requireLowercase: ${data.auth.requireLowercase}, requireNumber: ${data.auth.requireNumber}, requireSpecialChar: ${data.auth.requireSpecialChar}, requireUppercase: ${data.auth.requireUppercase}`);
        console.log(`    Verify Email Method: ${data.auth.verifyEmailMethod}`);
        console.log(`    Reset Password Method: ${data.auth.resetPasswordMethod}`);

        // Database
        console.log('\n  Database');
        console.log(`    Size: ${formatSize(data.database.totalSizeInGB)}`);
        if (data.database.tables.length) {
          outputTable(
            ['Table', 'Records'],
            data.database.tables.map((t) => [t.tableName, String(t.recordCount)]),
          );
        } else {
          console.log('    No tables.');
        }

        // Storage
        console.log('\n  Storage');
        console.log(`    Size: ${formatSize(data.storage.totalSizeInGB)}`);
        if (data.storage.buckets.length) {
          outputTable(
            ['Bucket', 'Public', 'Objects'],
            data.storage.buckets.map((b) => [b.name, b.public ? 'Yes' : 'No', String(b.objectCount ?? '-')]),
          );
        } else {
          console.log('    No buckets.');
        }

        // Functions
        console.log('\n  Functions');
        if (data.functions.length) {
          outputTable(
            ['Slug', 'Name', 'Status', 'Description'],
            data.functions.map((f) => [f.slug, f.name, f.status, f.description || '-']),
          );
        } else {
          console.log('    No functions deployed.');
        }

        // AI
        if (data.aiIntegration?.models?.length) {
          console.log('\n  AI Models');
          outputTable(
            ['Model', 'Input', 'Output'],
            data.aiIntegration.models.map((m) => [
              m.modelId,
              m.inputModality.join(', '),
              m.outputModality.join(', '),
            ]),
          );
        }

        // Realtime
        if (data.realtime?.channels && Array.isArray(data.realtime.channels) && data.realtime.channels.length) {
          console.log(`\n  Realtime: ${data.realtime.channels.length} channel(s)`);
          outputTable(
            ['Id', 'Pattern', 'Webhook URLs', 'Enabled', 'Description'],
            data.realtime.channels.map((c) => [c.id, c.pattern, c.webhookUrls?.join(', ') || '-', c.enabled ? 'Yes' : 'No', c.description || '-']),
          );
        }

        // Version
        if (data.version) {
          console.log(`\n  Version: ${data.version}`);
        }

        console.log('');
        await reportCliUsage('cli.metadata', true);
      } catch (err) {
        await reportCliUsage('cli.metadata', false);
        await trackTopLevelUsage('metadata', false, {}, err);
        handleError(err, json);
      }
    });
}

function formatSize(gb: number): string {
  if (gb < 0.001) return `${(gb * 1024 * 1024).toFixed(1)} KB`;
  if (gb < 1) return `${(gb * 1024).toFixed(2)} MB`;
  return `${gb.toFixed(2)} GB`;
}
