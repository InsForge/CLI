import type { Command } from 'commander';
import { registerApifyConnectCommand } from './apify/connect.js';
import { registerApifyLoginCommand } from './apify/login.js';

// Mirrors payments/index.ts: a category group with one subcommand per provider.
// Apify is the first web scraper provider; future providers (e.g. Firecrawl) slot in here.
export function registerWebscraperCommands(webscraperCmd: Command): void {
  webscraperCmd.description('Manage web scraper integrations');

  const apifyCmd = webscraperCmd.command('apify').description('Manage the Apify web scraper');
  registerApifyConnectCommand(apifyCmd);
  registerApifyLoginCommand(apifyCmd);
}
