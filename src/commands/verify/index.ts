// src/commands/verify/index.ts
import type { Command } from 'commander';
import { registerVerifyRlsCommand } from './rls.js';
import { registerVerifyTruthCommand } from './truth.js';
import { registerVerifyFindingCommand } from './finding.js';

export function registerVerifyCommands(program: Command): void {
  const verify = program
    .command('verify', { hidden: true })
    .description('[experimental] Backend-truth & RLS probes + loud-error recording for insforge-verify');
  registerVerifyRlsCommand(verify);
  registerVerifyTruthCommand(verify);
  registerVerifyFindingCommand(verify);
}
