import type { Command } from 'commander';

export function registerBranchDeleteCommand(branch: Command): void {
  branch
    .command('delete <name>')
    .description('Delete a branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(() => {
      throw new Error('Not implemented');
    });
}
