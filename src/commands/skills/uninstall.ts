import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { resolveTargetDir, uninstallSkill } from '../../lib/skills-install.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';

export function registerSkillsUninstallCommand(skillsCmd: Command): void {
  skillsCmd
    .command('uninstall <name>')
    .description('Remove an installed InsForge skill from the target directory')
    .option('--target-dir <path>', 'Override the target directory (defaults to ~/.claude/skills)')
    .action(async (name: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const targetDir = (opts.targetDir as string | undefined) ?? resolveTargetDir();
        const res = await uninstallSkill(name, targetDir);

        if (json) {
          outputJson(res);
          return;
        }

        if (!res.removed) {
          throw new CLIError(
            `Skill "insforge-${name}" is not installed at ${targetDir}.`,
            4,
            'NOT_FOUND',
          );
        }

        clack.log.success(`Removed ${res.path}`);
      } catch (err) {
        handleError(err, json);
      }
    });
}
