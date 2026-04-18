import type { Command } from 'commander';
import {
  listBundledSkills,
  listInstalledSkills,
  resolveBundledSkillsDir,
  resolveTargetDir,
} from '../../lib/skills-install.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

export function registerSkillsListCommand(skillsCmd: Command): void {
  skillsCmd
    .command('list')
    .description('List installed InsForge skills and bundled-but-not-installed skills')
    .option('--target-dir <path>', 'Override the target directory (defaults to ~/.claude/skills)')
    .option('--skills-src-dir <path>', 'Override the bundled-skills source directory')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const targetDir = (opts.targetDir as string | undefined) ?? resolveTargetDir();
        const skillsSrcDir = (opts.skillsSrcDir as string | undefined) ?? resolveBundledSkillsDir();

        const [bundled, installed] = await Promise.all([
          listBundledSkills(skillsSrcDir),
          listInstalledSkills(targetDir),
        ]);

        const installedSlugs = new Set(installed.map((s) => s.slug));
        const bundledSlugs = new Set(bundled.map((s) => s.slug));

        // Union of all known skills, reporting which is installed vs bundled-only
        const allSlugs = Array.from(new Set([...installedSlugs, ...bundledSlugs])).sort();

        const rows = allSlugs.map((slug) => {
          const isInstalled = installedSlugs.has(slug);
          const isBundled = bundledSlugs.has(slug);
          let status: string;
          if (isInstalled && isBundled) status = 'installed';
          else if (isInstalled && !isBundled) status = 'installed (no longer bundled)';
          else status = 'available';
          return { slug, status };
        });

        if (json) {
          outputJson({
            targetDir,
            skillsSrcDir,
            skills: rows,
          });
          return;
        }

        if (rows.length === 0) {
          console.log('No skills installed and no skills bundled.');
          console.log(`(target: ${targetDir})`);
          return;
        }

        outputTable(
          ['Skill', 'Status', 'Path'],
          rows.map((r) => [
            `insforge-${r.slug}`,
            r.status,
            r.status.startsWith('installed')
              ? `${targetDir}/insforge-${r.slug}`
              : `${skillsSrcDir}/${r.slug}/SKILL.md`,
          ]),
        );
      } catch (err) {
        handleError(err, json);
      }
    });
}
