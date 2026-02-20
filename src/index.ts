import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
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
import { registerRecordsCommands } from './commands/records/list.js';
import { registerRecordsCreateCommand } from './commands/records/create.js';
import { registerRecordsUpdateCommand } from './commands/records/update.js';
import { registerRecordsDeleteCommand } from './commands/records/delete.js';
import { registerFunctionsCommands } from './commands/functions/list.js';
import { registerFunctionsDeployCommand } from './commands/functions/deploy.js';
import { registerFunctionsInvokeCommand } from './commands/functions/invoke.js';
import { registerFunctionsCodeCommand } from './commands/functions/code.js';
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
import { registerDeploymentsMetadataCommand } from './commands/deployments/metadata.js';
import { registerDeploymentsSlugCommand } from './commands/deployments/slug.js';

const INSFORGE_LOGO = `
██╗███╗   ██╗███████╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗
██║████╗  ██║██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
██║██╔██╗ ██║███████╗█████╗  ██║   ██║██████╔╝██║  ███╗█████╗
██║██║╚██╗██║╚════██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
██║██║ ╚████║███████║██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
╚═╝╚═╝  ╚═══╝╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
`;

function showLogoOnFirstRun(): void {
  if (process.argv.includes('--json')) return;

  const localDir = join(process.cwd(), '.insforge');
  if (existsSync(localDir)) return;

  console.log(INSFORGE_LOGO);
  console.log('  Welcome to InsForge CLI! Run `insforge login` to get started.\n');

  mkdirSync(localDir, { recursive: true });
}

showLogoOnFirstRun();

const program = new Command();

program
  .name('insforge')
  .description('InsForge CLI - Command line tool for InsForge platform')
  .version('0.1.0');

// Global options
program
  .option('--json', 'Output in JSON format')
  .option('--project-id <id>', 'Override linked project ID')
  .option('--api-url <url>', 'Override Platform API URL')
  .option('-y, --yes', 'Skip confirmation prompts');

// Top-level commands
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerCreateCommand(program);
registerContextCommand(program);
registerListCommand(program);
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
// registerDeploymentsMetadataCommand(deploymentsCmd);
// slug command doesn't work yet.
// registerDeploymentsSlugCommand(deploymentsCmd);

program.parse();
