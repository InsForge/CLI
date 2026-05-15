# Developing the InsForge CLI

Notes for anyone (human or agent) making changes to the `@insforge/cli` repo.
Read this before touching source files.

## 1. Follow the existing patterns

The codebase has well-established conventions — stay consistent with them
rather than inventing new structures.

- **Command layout.** Every command lives under `src/commands/<group>/<cmd>.ts`
  and exports a `registerXxxCommand(parent: Command)` function that attaches
  itself to the parent Commander instance. The top-level registration happens
  in `src/index.ts`. New commands must follow the same registration pattern.
- **API clients.** Platform API calls go through `src/lib/api/platform.ts`
  (`platformFetch`), OSS/self-hosted calls through `src/lib/api/oss.ts`
  (`ossFetch`). Do **not** call `fetch` directly from command files — add a
  typed wrapper to the appropriate client module.
- **Config.** Use helpers from `src/lib/config.ts` (`getProjectConfig`,
  `getPlatformApiUrl`, etc.). Never read config files directly.
- **Errors.** Throw `CLIError` / `AuthError` / `ProjectNotLinkedError` from
  `src/lib/errors.ts`. Always let the top-level `handleError(err, json)` in the
  command action render the error — don't print errors yourself.
- **Output.** Use `outputJson` / `outputTable` / `outputSuccess` from
  `src/lib/output.ts`. Respect the `--json` flag via `getRootOpts(cmd)`.
- **Interactive prompts.** Use `@clack/prompts` (already imported in most
  command files). Never prompt when `--json` is set.
- **Imports.** TypeScript ESM — imports must use `.js` extensions
  (e.g. `from '../lib/config.js'`), even for `.ts` source files.

When in doubt, find the closest existing command and copy its structure.

## 2. Use PostHog for usage analytics

The CLI uses PostHog (wired up in `src/lib/analytics.ts`) to track which
commands and features are actually being used. This is the single source of
truth for product telemetry — do not add alternative analytics systems.

- **Entry point.** Import `captureEvent` (or a typed helper like
  `trackDiagnose`) from `src/lib/analytics.ts`. Add a new helper there if
  several commands will share an event shape.
- **Distinct ID.** Use `project_id` (or `org_id` where a project isn't yet
  linked, e.g. in `create`) as the distinct ID so events can be grouped per
  project/org.
- **Event names.** Use the `cli_<feature>_<action>` convention
  (e.g. `cli_diagnose_invoked`). Keep event names stable — renaming breaks
  dashboards.
- **Properties.** Include only non-sensitive metadata: `project_id`,
  `project_name`, `org_id`, `region`, `subcommand`, feature flags. **Never**
  send SQL, file contents, credentials, or user-entered free text.
- **Flush.** Always call `await shutdownAnalytics()` in a `finally` block so
  events are flushed before the process exits. PostHog Node SDK batches by
  default and will drop events on a hard exit.
- **Build-time key.** `POSTHOG_API_KEY` is injected at build time by
  `tsup.config.ts` via `define`. Local builds without the env var become a
  no-op automatically — the CLI itself stays functional.

**Do not** use `reportCliUsage` for new commands — that legacy OSS telemetry
path has been removed from `create`, `link`, and `docs`. PostHog is the path
going forward.

## 3. Keep InsForge agent skills in sync

The CLI auto-installs agent skills via `installSkills()` in
`src/lib/skills.ts`. Those skills live in a separate repo
(`InsForge/agent-skills`) and teach AI coding agents how to use the InsForge
SDK and CLI.

When you add, rename, or change the behavior of a user-facing CLI command,
you almost certainly need to update the `insforge-cli` skill in the
`agent-skills` repo as well — otherwise the skill will be stale and agents
will generate wrong commands.

Checklist when changing a command:

- [ ] Does the `insforge-cli` skill document this command? If yes, open a PR
      in `InsForge/agent-skills` to update it in the same change set.
- [ ] Did flags, defaults, or output shape change? Update the skill examples.
- [ ] Did a command get renamed or removed? Remove or rename in the skill.
- [ ] Did you add a new command? Decide whether agents should know about it
      and add it to the skill if so.

Mention the skill repo update in the CLI PR description so reviewers can
cross-reference both PRs.

## 4. Release workflow

Releases are fully automated via GitHub Actions
([`.github/workflows/publish.yml`](.github/workflows/publish.yml)).
The CLI is published to npm as `@insforge/cli` whenever a version tag is
pushed.

**Steps to ship a release:**

1. **Bump the version** in `package.json` (e.g. `0.1.41` → `0.1.42`) on your
   feature branch or on `main`. Follow semver — patch for fixes, minor for
   additive features, major for breaking changes.
2. **Commit the bump** with a message like `chore: bump version to X.Y.Z`.
3. **Merge to `main`** via PR as usual.
4. **Create and push a tag** matching the version on `main`:
   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
5. The `publish` workflow triggers on the tag push and:
   - Runs `npm run build` with `POSTHOG_API_KEY` injected from repo secrets.
   - Runs `npm publish --access public` with `NPM_TOKEN` from repo secrets.
6. **Verify** the new version appears on
   [npmjs.com/package/@insforge/cli](https://www.npmjs.com/package/@insforge/cli)
   and that `npx @insforge/cli@latest --version` returns the expected version.

**Do not** publish manually from a local machine — that bypasses the CI build
(and therefore the PostHog key injection) and leads to analytics being
silently disabled in published artifacts.

If a release goes wrong, deprecate the bad version with `npm deprecate` rather
than unpublishing — unpublishing breaks downstream users who already installed
that version.
