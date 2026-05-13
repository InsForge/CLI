import type { Command } from 'commander';
import { registerAiSetupCommand } from './setup.js';

export function registerAiCommands(aiCmd: Command): void {
  registerAiSetupCommand(aiCmd);
}
