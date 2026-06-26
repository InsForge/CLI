import type { Command } from 'commander';
import { registerApifyConnectCommand } from './apify/connect.js';
import { registerApifyLoginCommand } from './apify/login.js';

// Mirrors payments/index.ts: a category group with one subcommand per provider.
// Apify is the first data source; future providers (e.g. Firecrawl) slot in here.
export function registerDatasourceCommands(datasourceCmd: Command): void {
  datasourceCmd.description('Manage data-source integrations');

  const apifyCmd = datasourceCmd.command('apify').description('Manage the Apify data source');
  registerApifyConnectCommand(apifyCmd);
  registerApifyLoginCommand(apifyCmd);
}
