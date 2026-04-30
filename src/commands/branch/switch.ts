import type { Command } from 'commander';

export interface RunBranchSwitchOptions {
  name?: string;
  toParent?: boolean;
  apiUrl: string | undefined;
  json: boolean;
}

/** Public so `branch create` can auto-switch on success without going through Commander again. */
export async function runBranchSwitch(_input: RunBranchSwitchOptions): Promise<void> {
  throw new Error('Not implemented');
}

export function registerBranchSwitchCommand(branch: Command): void {
  branch
    .command('switch [name]')
    .description("Switch this directory's context to a branch (or back with --parent)")
    .option('--parent', 'Switch back to the parent project')
    .action(() => {
      throw new Error('Not implemented');
    });
}
