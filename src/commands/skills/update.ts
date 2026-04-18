import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import {
  installBundledSkills,
  resolveBundledSkillsDir,
  resolveTargetDir,
} from '../../lib/skills-install.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';

export function registerSkillsUpdateCommand(skillsCmd: Command): void {
  skillsCmd
    .command('update [name]')
    .description('Re-copy InsForge skills from the bundle, overwriting existing files')
    .option('--keep-local', 'Preserve any locally-edited skill files instead of overwriting')
    .option('--target-dir <path>', 'Override the target directory (defaults to ~/.claude/skills)')
    .option('--skills-src-dir <path>', 'Override the bundled-skills source directory')
    .action(async (name: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const targetDir = (opts.targetDir as string | undefined) ?? resolveTargetDir();
        const skillsSrcDir = (opts.skillsSrcDir as string | undefined) ?? resolveBundledSkillsDir();
        const keepLocal = Boolean(opts.keepLocal);

        const res = await installBundledSkills({
          targetDir,
          skillsSrcDir,
          // update overwrites by default; --keep-local flips that
          force: !keepLocal,
          keepLocal,
          only: name ? [name] : undefined,
        });

        if (json) {
          outputJson(res);
          return;
        }

        if (res.results.length === 1 && res.results[0].status === 'missing-source') {
          clack.log.warn(
            `No skills bundled at ${res.skillsSrcDir}. This is likely a local dev build — run \`npm run build:skills\`, or install \`@insforge/cli\` from npm.`,
          );
          return;
        }

        clack.log.info(`Updating InsForge skills at ${res.targetDir}`);
        for (const r of res.results) {
          const label = `insforge-${r.slug}`;
          switch (r.status) {
            case 'installed':
              clack.log.success(`${label} — installed`);
              break;
            case 'updated':
              clack.log.success(`${label} — overwritten`);
              break;
            case 'skipped-keep-local':
              clack.log.info(`${label} — kept local copy`);
              break;
            case 'skipped-exists':
              clack.log.info(`${label} — already up to date`);
              break;
            default:
              clack.log.info(`${label} — ${r.status}`);
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
