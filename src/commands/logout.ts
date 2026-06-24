import type { Command } from 'commander';
import { clearCredentials } from '../lib/config.js';
import { handleError, getRootOpts } from '../lib/errors.js';
import { outputSuccess, outputJson } from '../lib/output.js';
import { trackTopLevelUsage } from '../lib/command-telemetry.js';

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Log out from InsForge platform')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        clearCredentials();

        await trackTopLevelUsage('logout', true);

        if (json) {
          outputJson({ success: true, message: 'Logged out successfully' });
        } else {
          outputSuccess('Logged out successfully.');
        }
      } catch (err) {
        await trackTopLevelUsage('logout', false, {}, err);
        handleError(err, json);
      }
    });
}
