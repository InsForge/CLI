# Bundled skills install + `insforge skills` subcommand family

## Problem

`@insforge/cli` needs a first-class way for users (and the `insforge init` wrapper
in CLI#73) to install the InsForge agent skill files into their local Claude
configuration. Today we already have `installSkills()` in `src/lib/skills.ts`
(merged in #72) that shells out to `npx skills add insforge/agent-skills -g …`
and installs into `~/.agents/skills/` with per-agent symlinks. That works, but
it depends on a third-party `skills` CLI, an internet connection, and the
`insforge/agent-skills` bundle being reachable on the npm registry.

Ticket #74 asks for a different, complementary mechanism: **bundle the skill
markdown files directly into the `@insforge/cli` npm package** and copy them
into `~/.claude/skills/insforge-<slug>/` on demand. This gives:

- offline-capable install (files ship inside the tarball)
- first-class `insforge skills` subcommand family (`list` / `install` /
  `update` / `uninstall`) so users can manage skills without running `init`
- a stable library surface (`installBundledSkills()`) that CLI#73's `init`
  wrapper can call directly, keeping the primitives-vs-wrapper split clean

The pinned operator comment on the ticket confirms this direction: `skills` is
a primitive family that `init` uses; neither mechanism is being removed by the
other.

## Goals

1. New library: `src/lib/skills-install.ts` exporting
   `installBundledSkills({ targetDir?, force?, skillsSrcDir?, only? })` that
   copies bundled `SKILL.md` files into `<targetDir>/insforge-<slug>/SKILL.md`
   with correct perms (0644 / 0755).
2. New subcommand family `insforge skills`:
   - `list`   — show installed (under `~/.claude/skills/insforge-*`) and
     bundled-but-not-installed skills.
   - `install [name]` — install a specific skill, or all if no name.
   - `update [name]` — re-copy from bundle (overwrites unless `--keep-local`).
   - `uninstall <name>` — remove `~/.claude/skills/insforge-<name>/`.
3. Build-time bundling: a one-shot `npm run build:skills` script populates
   `dist/skills/<slug>/SKILL.md` from the `InsForge/insforge-skills` repo.
   `prepublishOnly` runs it before `npm publish` so published tarballs contain
   real skills. Local `npm run build` does not require network — if
   `dist/skills/` is empty, `insforge skills install` prints a friendly hint.
4. Env overrides: default target is `~/.claude/skills/` but respect
   `CLAUDE_CONFIG_DIR` (→ `<CLAUDE_CONFIG_DIR>/skills/`) and
   `XDG_CONFIG_HOME` (→ `<XDG_CONFIG_HOME>/claude/skills/`) when set.
5. Vitest coverage: unit test the library against a fixture bundle in a
   temp dir, asserting files, perms, skip-if-exists, `force`, and env
   overrides.

## Non-goals

- Modifying `src/commands/init.ts` or the existing `src/lib/skills.ts`
  (CLI#73 is the `init` wrapper that will call `installBundledSkills()`; #72's
  `installSkills(json)` is a separate third-party-based install path and
  stays as-is so we don't regress the existing onboarding).
- Auto-update / version-check on `insforge` launches.
- Signature / checksum verification of skill files.
- Publishing to `claude plugin` marketplaces.

## Proposed approach

### Library (`src/lib/skills-install.ts`)

Pure library, no I/O beyond `fs/promises`. The core function:

```ts
export interface BundledSkillsInstallOptions {
  targetDir?: string;       // defaults to resolveTargetDir()
  skillsSrcDir?: string;    // defaults to resolveBundledSkillsDir()
  force?: boolean;          // overwrite existing on install
  only?: string[];          // if set, only install skills whose slug matches
  keepLocal?: boolean;      // update-only: skip if target already exists
}

export interface BundledSkillResult {
  slug: string;
  status: 'installed' | 'updated' | 'skipped-exists' | 'skipped-keep-local' | 'missing-source';
  path: string;
  bytes?: number;
}

export interface InstallBundledSkillsResult {
  targetDir: string;
  skillsSrcDir: string;
  results: BundledSkillResult[];
}

export async function installBundledSkills(
  opts?: BundledSkillsInstallOptions,
): Promise<InstallBundledSkillsResult>;
```

Helpers also exported for reuse by the command layer:

- `resolveTargetDir(env = process.env): string`
- `resolveBundledSkillsDir(): string` — locates `dist/skills/` next to the
  compiled `dist/index.js`.
- `listBundledSkills(skillsSrcDir?): Promise<{ slug: string; path: string }[]>`
- `listInstalledSkills(targetDir?): Promise<{ slug: string; path: string }[]>`
- `uninstallSkill(slug, targetDir?): Promise<{ removed: boolean; path: string }>`

Naming note: we deliberately **do not** use `installSkills` to avoid colliding
with the existing export in `src/lib/skills.ts`. The new function has a
different signature (options bag, returns result) and a different mechanism
(copy-from-bundle vs. shell-out-to-npx), so they live side by side under
distinct names.

### Command family (`src/commands/skills/`)

Mirror the multi-command dir shape used by `src/commands/secrets/`,
`src/commands/projects/`, `src/commands/diagnose/`. One
`register*` function per file, wired up by a new `skills` group in
`src/index.ts`.

- `list.ts` — prints a table (`outputTable`) of installed + bundled skills
  with their status. JSON mode outputs the raw list.
- `install.ts` — `insforge skills install [name]`. `--force` overwrites.
  `--target-dir <path>` override for advanced users (mainly useful for tests).
- `update.ts` — `insforge skills update [name]`. `--keep-local` preserves
  existing files (treats them as skipped, not overwritten).
- `uninstall.ts` — `insforge skills uninstall <name>`. Friendly error if
  the skill is not installed.

All commands reuse the existing `getRootOpts` / `handleError` / `outputJson`
patterns; all I/O uses `fs/promises`; error messages match the existing
`clack.log.*` tone.

### Build-time bundling

Option A from the ticket. Concretely:

1. New script `scripts/build-skills.sh` (bash, no extra deps): clones
   `InsForge/insforge-skills` into a tmpdir, copies each
   `skill-*/SKILL.md` into `<repo>/dist/skills/<slug>/SKILL.md` with the
   `skill-` prefix stripped. Idempotent.
2. New `package.json` script: `"build:skills": "scripts/build-skills.sh"`.
3. `prepublishOnly` gets updated from `npm run lint && npm run build` to
   `npm run lint && npm run build && npm run build:skills`, so published
   tarballs always contain the skills.
4. `tsup.config.ts` is **not** modified — skills are runtime assets, not
   JS, and we want them under `dist/skills/` in the published tarball.
   The `files: ["dist"]` entry in `package.json` already includes them.

If `dist/skills/` is empty at runtime (local dev without running
`build:skills`), `installBundledSkills()` returns an empty result with a
`missing-source` sentinel; the command layer shows:

> No skills bundled. This is a local dev build — run `npm run build:skills`
> to populate `dist/skills/`, or install `@insforge/cli` from npm.

### Env override resolution

```ts
function resolveTargetDir(env = process.env): string {
  if (env.INSFORGE_SKILLS_TARGET_DIR) return env.INSFORGE_SKILLS_TARGET_DIR; // test hook
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, 'skills');
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'claude', 'skills');
  return join(homedir(), '.claude', 'skills');
}
```

Precedence documented in the README.

## Test plan

- `src/lib/skills-install.test.ts` (Vitest):
  - `resolveTargetDir` honors each env var with the documented precedence.
  - `installBundledSkills` with a fixture `dist/skills/alpha/SKILL.md` +
    `dist/skills/beta/SKILL.md` writes `insforge-alpha` + `insforge-beta`
    under a per-test tmpdir, sets mode `0644` on files and `0755` on dirs.
  - Re-running without `force` returns `skipped-exists` and does not touch
    mtimes.
  - Re-running with `force` overwrites.
  - `only: ['alpha']` installs just alpha.
  - `keepLocal: true` behaves like `force: false` even in update flows.
  - Empty `skillsSrcDir` returns a single `missing-source` result.
- `src/commands/skills/install.test.ts` (lightweight): wires up a fake
  `Command`, points env vars at a tmpdir, asserts `list.ts` output and
  `uninstall.ts` round-trip. If the commander scaffolding is heavy we keep
  coverage at the library layer and smoke-test the command via one
  end-to-end case.
- `npm test` + `npm run lint` both green before opening the PR.

## Risks / rollback

- **Build-step network dep:** `scripts/build-skills.sh` pulls from
  `InsForge/insforge-skills` at publish time. Mitigation: only
  `prepublishOnly` runs it; `npm run build` does not. Rollback: delete the
  script + revert the `prepublishOnly` change.
- **User confusion between two install paths:** `insforge init` currently
  calls the old `installSkills()` (npx-based). This ticket does not rewire
  `init`. CLI#73's worker is the one that swaps `init` to call
  `installBundledSkills()`. Until then, the two mechanisms coexist and the
  README notes this explicitly. Rollback: remove the new command group
  from `src/index.ts`; the library stays but is dormant.
- **`fs.cp` availability:** `fs/promises.cp` is stable on Node 18+
  (the engine floor in `package.json`). We use it with `{ recursive: true,
  preserveTimestamps: false }` and set perms explicitly after copy.

## Out of scope for this PR

- `insforge init` integration (CLI#73).
- Telemetry (`reportCliUsage`) on the new commands — can be added as a
  follow-up; doesn't change behavior.
- Removing or deprecating the existing `installSkills()` in `src/lib/skills.ts`.
