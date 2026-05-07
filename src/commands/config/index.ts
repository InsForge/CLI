// CLI/src/commands/config/index.ts
import type { Command } from 'commander';
import { registerConfigExportCommand } from './export.js';
import { registerConfigPlanCommand } from './plan.js';
import { registerConfigApplyCommand } from './apply.js';

export function registerConfigCommand(program: Command): void {
  const cfg = program
    .command('config')
    .description('Manage insforge.toml (declarative project configuration)');
  registerConfigExportCommand(cfg);
  registerConfigPlanCommand(cfg);
  registerConfigApplyCommand(cfg);
}
