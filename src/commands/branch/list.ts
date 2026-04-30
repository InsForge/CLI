import type { Command } from 'commander';

export function registerBranchListCommand(branch: Command): void {
  branch
    .command('list')
    .description('List branches of the currently linked project')
    .action(() => {
      throw new Error('Not implemented');
    });
}
