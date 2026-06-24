import type { Command } from 'commander';
import { getProfile } from '../lib/api/platform.js';
import { handleError, getRootOpts } from '../lib/errors.js';
import { outputJson, outputInfo } from '../lib/output.js';
import { requireAuth } from '../lib/credentials.js';
import { trackTopLevelUsage } from '../lib/command-telemetry.js';

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Show current authenticated user')
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const profile = await getProfile(apiUrl);

        await trackTopLevelUsage('whoami', true);

        if (json) {
          outputJson(profile);
        } else {
          outputInfo(`Logged in as: ${profile.email ?? profile.name}`);
          if (profile.name) outputInfo(`Name: ${profile.name}`);
          if (profile.id) outputInfo(`ID: ${profile.id}`);
        }
      } catch (err) {
        await trackTopLevelUsage('whoami', false, {}, err);
        handleError(err, json);
      }
    });
}
