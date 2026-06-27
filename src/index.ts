import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as prompts from './lib/prompts.js';
import { getCredentials, getProjectConfig } from './lib/config.js';
import { registerLoginCommand } from './commands/login.js';
import { registerLogoutCommand } from './commands/logout.js';
import { registerWhoamiCommand } from './commands/whoami.js';
import { registerOrgsCommands } from './commands/orgs/list.js';
import { registerOrgsManageCommands } from './commands/orgs/manage.js';
import { registerProjectsCommands } from './commands/projects/list.js';
import { registerProjectManageCommands } from './commands/projects/manage.js';
import { registerBillingCommands } from './commands/billing/index.js';
import { registerUsageCommand } from './commands/usage/index.js';
import { registerBackupsCommands } from './commands/backups/index.js';
import { registerBranchCommands } from './commands/branch/index.js';
import { registerProjectLinkCommand } from './commands/projects/link.js';
import { registerDbCommands } from './commands/db/query.js';
import { registerDbTablesCommand } from './commands/db/tables.js';
import { registerDbFunctionsCommand } from './commands/db/functions.js';
import { registerDbIndexesCommand } from './commands/db/indexes.js';
import { registerDbPoliciesCommand } from './commands/db/policies.js';
import { registerDbTriggersCommand } from './commands/db/triggers.js';
import { registerDbRpcCommand } from './commands/db/rpc.js';
import { registerDbExportCommand } from './commands/db/export.js';
import { registerDbImportCommand } from './commands/db/import.js';
import { registerDbMigrationsCommand } from './commands/db/migrations.js';
import { registerDbConnectionStringCommand } from './commands/db/connection-string.js';
import { registerRecordsCommands } from './commands/records/list.js';
import { registerRecordsCreateCommand } from './commands/records/create.js';
import { registerRecordsUpdateCommand } from './commands/records/update.js';
import { registerRecordsDeleteCommand } from './commands/records/delete.js';
import { registerFunctionsCommands } from './commands/functions/list.js';
import { registerFunctionsDeployCommand } from './commands/functions/deploy.js';
import { registerFunctionsInvokeCommand } from './commands/functions/invoke.js';
import { registerFunctionsCodeCommand } from './commands/functions/code.js';
import { registerFunctionsDeleteCommand } from './commands/functions/delete.js';
import { registerStorageBucketsCommand } from './commands/storage/buckets.js';
import { registerStorageUploadCommand } from './commands/storage/upload.js';
import { registerStorageDownloadCommand } from './commands/storage/download.js';
import { registerStorageCreateBucketCommand } from './commands/storage/create-bucket.js';
import { registerStorageDeleteBucketCommand } from './commands/storage/delete-bucket.js';
import { registerStorageListObjectsCommand } from './commands/storage/list-objects.js';
import { registerCreateCommand } from './commands/create.js';
import { registerContextCommand } from './commands/info.js';
import { registerListCommand } from './commands/list.js';
import { registerDeploymentsDeployCommand } from './commands/deployments/deploy.js';
import { registerDeploymentsListCommand } from './commands/deployments/list.js';
import { registerDeploymentsStatusCommand } from './commands/deployments/status.js';
import { registerDeploymentsCancelCommand } from './commands/deployments/cancel.js';
import { registerDeploymentsEnvVarsCommand } from './commands/deployments/env-vars.js';
import { registerDeploymentsMetadataCommand } from './commands/deployments/metadata.js';
import { registerDeploymentsSlugCommand } from './commands/deployments/slug.js';

import { registerDocsCommand } from './commands/docs.js';
import { registerSecretsListCommand } from './commands/secrets/list.js';
import { registerSecretsGetCommand } from './commands/secrets/get.js';
import { registerSecretsAddCommand } from './commands/secrets/add.js';
import { registerSecretsUpdateCommand } from './commands/secrets/update.js';
import { registerSecretsDeleteCommand } from './commands/secrets/delete.js';
import { registerSecretsRotateCommand } from './commands/secrets/rotate.js';
import { registerStorageS3KeysCommand } from './commands/storage/s3-keys.js';

import { registerSchedulesListCommand } from './commands/schedules/list.js';
import { registerSchedulesGetCommand } from './commands/schedules/get.js';
import { registerSchedulesCreateCommand } from './commands/schedules/create.js';
import { registerSchedulesUpdateCommand } from './commands/schedules/update.js';
import { registerSchedulesDeleteCommand } from './commands/schedules/delete.js';
import { registerSchedulesLogsCommand } from './commands/schedules/logs.js';

import { registerComputeListCommand } from './commands/compute/list.js';
import { registerComputeGetCommand } from './commands/compute/get.js';
import { registerComputeUpdateCommand } from './commands/compute/update.js';
import { registerComputeDeleteCommand } from './commands/compute/delete.js';
import { registerComputeStartCommand } from './commands/compute/start.js';
import { registerComputeStopCommand } from './commands/compute/stop.js';
import { registerComputeEventsCommand } from './commands/compute/events.js';
import { registerComputeDeployCommand } from './commands/compute/deploy.js';

import { registerLogsCommand } from './commands/logs.js';
import { registerMetadataCommand } from './commands/metadata.js';
import { registerDiagnoseCommands } from './commands/diagnose/index.js';
import { registerPaymentsCommands } from './commands/payments/index.js';
import { registerPosthogSetupCommand } from './commands/posthog/setup.js';
import { registerWebscraperCommands } from './commands/webscraper/index.js';
import { registerConfigCommand } from './commands/config/index.js';
import { registerAiCommands } from './commands/ai/index.js';
import { registerDomainsCommands } from './commands/domains/index.js';
import { registerMemoryCommands } from './commands/memory/index.js';
import { guardHook } from './lib/guard/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as { version: string };

const INSFORGE_LOGO = `
██╗███╗   ██╗███████╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗
██║████╗  ██║██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
██║██╔██╗ ██║███████╗█████╗  ██║   ██║██████╔╝██║  ███╗█████╗
██║██║╚██╗██║╚════██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
██║██║ ╚████║███████║██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
╚═╝╚═╝  ╚═══╝╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
`;

const program = new Command();

program
  .name('insforge')
  .description('InsForge CLI - Command line tool for InsForge platform')
  .version(pkg.version);

// Global options
program
  .option('--json', 'Output in JSON format')
  .option('--api-url <url>', 'Override Platform API URL')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--reason <text>', 'Agent: what the operation does and why (intent) — shown to the human approver for destructive operations')
  .option('--impact <text>', 'Agent: implications — who/what is affected, data loss, reversibility — shown on the approval page')
  .option('--recommendation <text>', 'Agent: your recommendation to the human approver')
  .option('--flag-destructive [reason]', 'Agent: flag this op as destructive for human approval even if InsForge\'s rules consider it safe (escalate-only — cannot downgrade the verdict)');

// Human-in-the-loop guard: a dispatch-pipeline stage that stops dangerous
// operations for human approval. Lives in the CLI so it protects every caller
// (Claude Code, Cursor, scripts, CI, humans) automatically.
program.hook('preAction', guardHook);

// Top-level commands
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerCreateCommand(program);
registerContextCommand(program);
registerListCommand(program);
registerDocsCommand(program);
registerProjectLinkCommand(program);

// Orgs commands
const orgsCmd = program.command('orgs').description('Manage organizations and members');
registerOrgsCommands(orgsCmd);
registerOrgsManageCommands(orgsCmd);

// Projects commands
const projectsCmd = program.command('projects').description('Manage projects');
registerProjectsCommands(projectsCmd);
registerProjectManageCommands(projectsCmd);

// Branch commands
registerBranchCommands(program);

// Database commands
const dbCmd = program.command('db').description('Database operations');
registerDbCommands(dbCmd);
registerDbTablesCommand(dbCmd);
registerDbFunctionsCommand(dbCmd);
registerDbIndexesCommand(dbCmd);
registerDbPoliciesCommand(dbCmd);
registerDbTriggersCommand(dbCmd);
registerDbRpcCommand(dbCmd);
registerDbExportCommand(dbCmd);
registerDbImportCommand(dbCmd);
registerDbMigrationsCommand(dbCmd);
registerDbConnectionStringCommand(dbCmd);

// Records commands (hidden — do not use for now)
const recordsCmd = program.command('records', { hidden: true }).description('CRUD operations on table records');
registerRecordsCommands(recordsCmd);
registerRecordsCreateCommand(recordsCmd);
registerRecordsUpdateCommand(recordsCmd);
registerRecordsDeleteCommand(recordsCmd);

// Functions commands
const functionsCmd = program.command('functions').description('Manage edge functions');
registerFunctionsCommands(functionsCmd);
registerFunctionsCodeCommand(functionsCmd);
registerFunctionsDeployCommand(functionsCmd);
registerFunctionsInvokeCommand(functionsCmd);
registerFunctionsDeleteCommand(functionsCmd);

// Storage commands
const storageCmd = program.command('storage').description('Manage storage');
registerStorageBucketsCommand(storageCmd);
registerStorageCreateBucketCommand(storageCmd);
registerStorageDeleteBucketCommand(storageCmd);
registerStorageListObjectsCommand(storageCmd);
registerStorageUploadCommand(storageCmd);
registerStorageDownloadCommand(storageCmd);
registerStorageS3KeysCommand(storageCmd);

// Deployments commands
const deploymentsCmd = program.command('deployments').description('Deploy and manage frontend sites');
registerDeploymentsDeployCommand(deploymentsCmd);
registerDeploymentsListCommand(deploymentsCmd);
registerDeploymentsStatusCommand(deploymentsCmd);
registerDeploymentsCancelCommand(deploymentsCmd);
registerDeploymentsEnvVarsCommand(deploymentsCmd);
registerDeploymentsMetadataCommand(deploymentsCmd);
registerDeploymentsSlugCommand(deploymentsCmd);

// Secrets commands
const secretsCmd = program.command('secrets').description('Manage secrets');
registerSecretsListCommand(secretsCmd);
registerSecretsGetCommand(secretsCmd);
registerSecretsAddCommand(secretsCmd);
registerSecretsUpdateCommand(secretsCmd);
registerSecretsDeleteCommand(secretsCmd);
registerSecretsRotateCommand(secretsCmd);

// Logs command
registerLogsCommand(program);

// Metadata command
registerMetadataCommand(program);

// Diagnose commands
const diagnoseCmd = program.command('diagnose');
registerDiagnoseCommands(diagnoseCmd);

// Payments commands
const paymentsCmd = program.command('payments').description('Manage payments');
registerPaymentsCommands(paymentsCmd);

// Billing commands (platform subscription / credits)
const billingCmd = program.command('billing').description('Inspect subscription, plan, and credits');
registerBillingCommands(billingCmd);

// Usage command (organization consumption)
registerUsageCommand(program);

// Backups commands (project backups)
const backupsCmd = program.command('backups').description('Manage project backups');
registerBackupsCommands(backupsCmd);

// Compute commands
const computeCmd = program.command('compute').description('Manage compute services (Docker containers on Fly.io)');
registerComputeListCommand(computeCmd);
registerComputeGetCommand(computeCmd);
registerComputeDeployCommand(computeCmd);
registerComputeUpdateCommand(computeCmd);
registerComputeDeleteCommand(computeCmd);
registerComputeStartCommand(computeCmd);
registerComputeStopCommand(computeCmd);
registerComputeEventsCommand(computeCmd);

// PostHog commands
const posthogCmd = program.command('posthog').description('Manage PostHog product analytics integration');
registerPosthogSetupCommand(posthogCmd);

// Web scraper commands (Apify first; provider as subcommand, like payments)
const webscraperCmd = program.command('webscraper').description('Manage web scraper integrations');
registerWebscraperCommands(webscraperCmd);

// AI commands
const aiCmd = program.command('ai').description('Manage AI model gateway setup');
registerAiCommands(aiCmd);

// Domain commands
registerDomainsCommands(program);

const memoryCmd = program.command('memory').description('Store and recall durable agent memories');
registerMemoryCommands(memoryCmd);

// Schedules commands
const schedulesCmd = program.command('schedules').description('Manage scheduled tasks (cron jobs)');
registerSchedulesListCommand(schedulesCmd);
registerSchedulesGetCommand(schedulesCmd);
registerSchedulesCreateCommand(schedulesCmd);
registerSchedulesUpdateCommand(schedulesCmd);
registerSchedulesDeleteCommand(schedulesCmd);
registerSchedulesLogsCommand(schedulesCmd);

// Config commands
registerConfigCommand(program);

if (process.argv.length <= 2 && process.stdout.isTTY) {
  await showInteractiveMenu();
} else {
  await program.parseAsync();
}

async function showInteractiveMenu(): Promise<void> {
  let isLoggedIn = false;
  let isLinked = false;

  try {
    isLoggedIn = !!getCredentials()?.access_token;
  } catch { /* corrupted credentials file */ }

  try {
    isLinked = !!getProjectConfig()?.project_id;
  } catch { /* no project config */ }

  console.log(INSFORGE_LOGO);
  clack.intro(`InsForge CLI v${pkg.version}`);

  type Action = 'login' | 'create' | 'link' | 'deploy' | 'docs' | 'help';
  const options: { value: Action; label: string; hint?: string }[] = [];

  if (!isLoggedIn) {
    options.push({ value: 'login', label: 'Log in to InsForge' });
  }

  options.push(
    { value: 'create', label: 'Create a new project', hint: isLoggedIn ? undefined : 'requires login' },
    { value: 'link', label: 'Link an existing project', hint: isLoggedIn ? undefined : 'requires login' },
  );

  if (isLinked) {
    options.push({ value: 'deploy', label: 'Deploy your project' });
  }

  options.push(
    { value: 'docs', label: 'View documentation' },
    { value: 'help', label: 'Show all commands' },
  );

  const action = await prompts.select<string>({
    message: 'What would you like to do?',
    options,
  });

  if (prompts.isCancel(action)) {
    clack.cancel('Bye!');
    process.exit(0);
  }

  switch (action) {
    case 'login':
      await program.parseAsync(['node', 'insforge', 'login']);
      break;
    case 'create':
      await program.parseAsync(['node', 'insforge', 'create']);
      break;
    case 'link':
      await program.parseAsync(['node', 'insforge', 'link']);
      break;
    case 'deploy':
      await program.parseAsync(['node', 'insforge', 'deployments', 'deploy']);
      break;
    case 'docs':
      await program.parseAsync(['node', 'insforge', 'docs']);
      break;
    case 'help':
      program.help();
      break;
  }
}
