import type { Command } from 'commander';

export function registerBranchMergeCommand(branch: Command): void {
  branch
    .command('merge <name>')
    .description("Merge a branch back to its parent project")
    .option('--dry-run', 'Compute the diff and print rendered SQL; do not apply')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--save-sql <path>', 'Write rendered SQL preview to a file')
    .action(() => {
      throw new Error('Not implemented');
    });
}
