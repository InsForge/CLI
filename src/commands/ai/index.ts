import type { Command } from 'commander';
import { registerAiSetupCommand } from './setup.js';
import { registerAiOverviewCommand } from './overview.js';

export function registerAiCommands(aiCmd: Command): void {
  registerAiSetupCommand(aiCmd);
  registerAiOverviewCommand(aiCmd);
}
