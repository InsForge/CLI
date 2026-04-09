---
name: cli-development
description: Use when working on the @insforge/cli codebase itself — adding or modifying commands under src/commands/, touching src/lib/api or src/lib/analytics, changing package.json version, wiring telemetry, or preparing an npm release. Covers code conventions, PostHog analytics, agent-skills sync, and the tag-triggered publish workflow.
license: Apache-2.0
metadata:
  organization: InsForge
---

# InsForge CLI Development

See the canonical development guide at [DEVELOPMENT.md](../../../DEVELOPMENT.md)
in the repo root. It covers:

1. **Existing code patterns** — command layout, API clients, config, errors,
   output, prompts, ESM imports.
2. **PostHog analytics** — `src/lib/analytics.ts`, event naming, distinct ID,
   property allow-list, flushing in `finally`, build-time key injection.
3. **Agent-skills sync** — when to update the `InsForge/agent-skills` repo
   alongside CLI command changes.
4. **Release workflow** — version bump → merge → tag `vX.Y.Z` → push → GitHub
   Actions publishes to npm.

Always read `DEVELOPMENT.md` before editing files under `src/`, touching
`package.json` version, or shipping a release.
