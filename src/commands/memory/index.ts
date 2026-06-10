import type { Command } from 'commander';
import { registerMemoryRememberCommand } from './remember.js';
import { registerMemoryRecallCommand } from './recall.js';
import { registerMemoryListCommand } from './list.js';

export function registerMemoryCommands(memoryCmd: Command): void {
  registerMemoryRememberCommand(memoryCmd);
  registerMemoryRecallCommand(memoryCmd);
  registerMemoryListCommand(memoryCmd);
}
