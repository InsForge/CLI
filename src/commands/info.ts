import type { Command } from 'commander';
import { getCredentials, getGlobalConfig, getProjectConfig } from '../lib/config.js';
import { handleError, getRootOpts } from '../lib/errors.js';
import { outputJson } from '../lib/output.js';

export function registerContextCommand(program: Command): void {
  program
    .command('current')
    .description('Show current CLI context (user, org, project)')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const creds = getCredentials();
        const globalConfig = getGlobalConfig();
        const projectConfig = getProjectConfig();

        if (json) {
          outputJson({
            authenticated: !!creds,
            user: creds?.user ?? null,
            default_org_id: globalConfig.default_org_id ?? null,
            project: projectConfig,
          });
          return;
        }

        console.log('\n  InsForge CLI Context\n');

        // Auth status
        if (creds) {
          console.log(`  User:          ${creds.user.name} <${creds.user.email}>`);
        } else {
          console.log('  User:          (not logged in)');
        }

        // Org (only relevant when logged in)
        if (creds && globalConfig.default_org_id) {
          console.log(`  Default Org:   ${globalConfig.default_org_id}`);
        } else if (creds) {
          console.log('  Default Org:   (none)');
        }

        // Project
        if (projectConfig) {
          console.log('');
          console.log(`  Project:       ${projectConfig.project_name} (${projectConfig.project_id})`);
          console.log(`  App Key:       ${projectConfig.appkey}`);
          console.log(`  Region:        ${projectConfig.region}`);
          console.log(`  OSS Host:      ${projectConfig.oss_host}`);
        } else {
          console.log('\n  Project:       (not linked — run `insforge link`)');
        }

        console.log('');
      } catch (err) {
        handleError(err, json);
      }
    });
}
