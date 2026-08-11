import type { Command } from 'commander';
import { registerLocalStartCommand } from './start.js';
import { registerLocalStopCommand } from './stop.js';
import { registerLocalStatusCommand } from './status.js';

export function registerLocalCommands(program: Command): void {
  const localCmd = program
    .command('local')
    .description('Run InsForge on your own machine in Docker (one instance per directory)');

  registerLocalStartCommand(localCmd);
  registerLocalStopCommand(localCmd);
  registerLocalStatusCommand(localCmd);
}
