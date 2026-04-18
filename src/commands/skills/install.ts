import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import {
  installBundledSkills,
  resolveBundledSkillsDir,
  resolveTargetDir,
  type BundledSkillResult,
} from '../../lib/skills-install.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';

export function registerSkillsInstallCommand(skillsCmd: Command): void {
  skillsCmd
    .command('install [name]')
    .description('Install InsForge skills from the bundled source. With no name, installs all.')
    .option('-f, --force', 'Overwrite existing skills at the target')
    .option('--target-dir <path>', 'Override the target directory (defaults to ~/.claude/skills)')
    .option('--skills-src-dir <path>', 'Override the bundled-skills source directory')
    .action(async (name: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const targetDir = (opts.targetDir as string | undefined) ?? resolveTargetDir();
        const skillsSrcDir = (opts.skillsSrcDir as string | undefined) ?? resolveBundledSkillsDir();

        const res = await installBundledSkills({
          targetDir,
          skillsSrcDir,
          force: Boolean(opts.force),
          only: name ? [name] : undefined,
        });

        if (json) {
          outputJson(res);
          return;
        }

        reportHumanResults(res.results, res.targetDir, res.skillsSrcDir);
      } catch (err) {
        handleError(err, json);
      }
    });
}

function reportHumanResults(
  results: BundledSkillResult[],
  targetDir: string,
  skillsSrcDir: string,
): void {
  if (results.length === 1 && results[0].status === 'missing-source') {
    clack.log.warn(
      `No skills bundled at ${skillsSrcDir}. This is likely a local dev build — run \`npm run build:skills\` to populate \`dist/skills/\`, or install \`@insforge/cli\` from npm.`,
    );
    return;
  }

  if (results.length === 0) {
    clack.log.info('No matching bundled skill to install.');
    return;
  }

  clack.log.info(`Installing InsForge skills to ${targetDir}`);
  for (const r of results) {
    const label = `insforge-${r.slug}`;
    switch (r.status) {
      case 'installed':
        clack.log.success(`${label} (${formatBytes(r.bytes)})`);
        break;
      case 'updated':
        clack.log.success(`${label} — overwritten (${formatBytes(r.bytes)})`);
        break;
      case 'skipped-exists':
        clack.log.info(`${label} — already installed (use --force to overwrite)`);
        break;
      case 'skipped-keep-local':
        clack.log.info(`${label} — kept local copy (--keep-local)`);
        break;
      default:
        clack.log.info(`${label} — ${r.status}`);
    }
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
