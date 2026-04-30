import type { Command } from 'commander';

export function registerBranchCreateCommand(branch: Command): void {
  branch
    .command('create <name>')
    .description('Create a branch from the currently linked project')
    .option('--mode <mode>', 'full | schema-only', 'full')
    .option('--no-switch', 'Do not auto-switch context after creation')
    .action(() => {
      throw new Error('Not implemented');
    });
}
