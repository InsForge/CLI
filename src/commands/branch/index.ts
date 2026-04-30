import type { Command } from 'commander';
import { registerBranchCreateCommand } from './create.js';
import { registerBranchListCommand } from './list.js';
import { registerBranchSwitchCommand } from './switch.js';
import { registerBranchMergeCommand } from './merge.js';
import { registerBranchDeleteCommand } from './delete.js';

export function registerBranchCommands(program: Command): void {
  const branch = program.command('branch').description('Manage backend branches');
  registerBranchCreateCommand(branch);
  registerBranchListCommand(branch);
  registerBranchSwitchCommand(branch);
  registerBranchMergeCommand(branch);
  registerBranchDeleteCommand(branch);
}
