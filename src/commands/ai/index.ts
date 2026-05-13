import type { Command } from 'commander';
import { registerAiSetupCommand } from './setup.js';

export function registerAiCommands(aiCmd: Command): void {
  aiCmd.description('Manage AI model gateway setup');
  registerAiSetupCommand(aiCmd);
}
