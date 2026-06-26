import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { handleError, getRootOpts } from '../../../lib/errors.js';
import { runApifyAuthBridge } from '../../../lib/apify-bridge.js';

/**
 * `insforge datasource apify login`
 *
 * Auth bridge: fetches the InsForge-managed Apify token, ensures the Apify CLI
 * is installed, runs `apify login --token <token>` (headless, no browser), and
 * installs apify/agent-skills so the local coding agent is immediately
 * Apify-ready.
 *
 * HARD REQUIREMENT: always `apify login --token`; never `apify login`
 * (which would open browser OAuth). On Apify 401 the user should re-run this
 * command — InsForge re-fetches a fresh token automatically.
 */
export function registerApifyLoginCommand(program: Command): void {
  program
    .command('login')
    .description(
      'Authenticate the local Apify CLI/agent using your InsForge-managed token (no browser)',
    )
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        if (!json) clack.log.info('Setting up Apify for your agent (token login + skills)...');
        const { skillsInstalled } = await runApifyAuthBridge(json);
        if (!json) {
          if (skillsInstalled) {
            clack.log.success('Apify CLI authenticated and agent skills installed.');
            clack.log.info('Tell your coding agent what to scrape.');
          } else {
            clack.log.success('Apify CLI authenticated.');
            clack.log.warn(
              'Agent skills did not install. Re-run `insforge datasource apify login`, or install manually with `npx skills add apify/agent-skills`.',
            );
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
