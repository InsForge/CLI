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
import { registerProjectsCommands } from './commands/projects/list.js';
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

import { registerDocsCommand } from './commands/docs.js';
import { registerSecretsListCommand } from './commands/secrets/list.js';
import { registerSecretsGetCommand } from './commands/secrets/get.js';
import { registerSecretsAddCommand } from './commands/secrets/add.js';
import { registerSecretsUpdateCommand } from './commands/secrets/update.js';
import { registerSecretsDeleteCommand } from './commands/secrets/delete.js';

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
import { registerComputeLogsCommand } from './commands/compute/logs.js';
import { registerComputeDeployCommand } from './commands/compute/deploy.js';

import { registerLogsCommand } from './commands/logs.js';
import { registerMetadataCommand } from './commands/metadata.js';
import { registerDiagnoseCommands } from './commands/diagnose/index.js';
import { registerPaymentsCommands } from './commands/payments/index.js';

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
  .option('-y, --yes', 'Skip confirmation prompts');

// Top-level commands
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerCreateCommand(program);
registerContextCommand(program);
registerListCommand(program);
registerDocsCommand(program);
registerProjectLinkCommand(program);

// Orgs commands (hidden — use `insforge list` instead)
const orgsCmd = program.command('orgs', { hidden: true }).description('Manage organizations');
registerOrgsCommands(orgsCmd);

// Projects commands (hidden — use `insforge list` instead)
const projectsCmd = program.command('projects', { hidden: true }).description('Manage projects');
registerProjectsCommands(projectsCmd);

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

// Deployments commands
const deploymentsCmd = program.command('deployments').description('Deploy and manage frontend sites');
registerDeploymentsDeployCommand(deploymentsCmd);
registerDeploymentsListCommand(deploymentsCmd);
registerDeploymentsStatusCommand(deploymentsCmd);
registerDeploymentsCancelCommand(deploymentsCmd);
registerDeploymentsEnvVarsCommand(deploymentsCmd);
// registerDeploymentsMetadataCommand(deploymentsCmd);
// slug command doesn't work yet.
// registerDeploymentsSlugCommand(deploymentsCmd);

// Secrets commands
const secretsCmd = program.command('secrets').description('Manage secrets');
registerSecretsListCommand(secretsCmd);
registerSecretsGetCommand(secretsCmd);
registerSecretsAddCommand(secretsCmd);
registerSecretsUpdateCommand(secretsCmd);
registerSecretsDeleteCommand(secretsCmd);

// Logs command
registerLogsCommand(program);

// Metadata command
registerMetadataCommand(program);

// Diagnose commands
const diagnoseCmd = program.command('diagnose');
registerDiagnoseCommands(diagnoseCmd);

// Payments commands
const paymentsCmd = program.command('payments').description('Manage Stripe payments');
registerPaymentsCommands(paymentsCmd);

// Compute commands
const computeCmd = program.command('compute').description('Manage compute services (Docker containers on Fly.io)');
registerComputeListCommand(computeCmd);
registerComputeGetCommand(computeCmd);
registerComputeDeployCommand(computeCmd);
registerComputeUpdateCommand(computeCmd);
registerComputeDeleteCommand(computeCmd);
registerComputeStartCommand(computeCmd);
registerComputeStopCommand(computeCmd);
registerComputeLogsCommand(computeCmd);

// Schedules commands
const schedulesCmd = program.command('schedules').description('Manage scheduled tasks (cron jobs)');
registerSchedulesListCommand(schedulesCmd);
registerSchedulesGetCommand(schedulesCmd);
registerSchedulesCreateCommand(schedulesCmd);
registerSchedulesUpdateCommand(schedulesCmd);
registerSchedulesDeleteCommand(schedulesCmd);
registerSchedulesLogsCommand(schedulesCmd);

if (process.argv.length <= 2 && process.stdout.isTTY) {
  await showInteractiveMenu();
} else {
  program.parse();
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
