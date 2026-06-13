// src/commands/preview/index.ts
import type { Command } from 'commander';
import { registerPreviewCreateCommand } from './create.js';
import { registerPreviewTeardownCommand } from './teardown.js';

export function registerPreviewCommands(program: Command): void {
  const preview = program
    .command('preview', { hidden: true })
    .description('[experimental] Isolated full-stack preview environments');
  registerPreviewCreateCommand(preview);
  registerPreviewTeardownCommand(preview);
}
