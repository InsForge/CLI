# Preview environments (experimental)

`insforge preview create` / `insforge preview teardown` — hidden, experimental
commands that stand up and tear down an **isolated full-stack environment** for
verifying a change before merging the branch to prod.

A "preview" is a thin orchestration layer over existing primitives: it creates a
copy-on-write **branch** (own backend + a copy of the data), records a local
**manifest** so teardown can find and remove it, and optionally **wires a local
env file** at the branch backend. It does not invent new backend behaviour.

## Where this fits — the verify loop

These commands are the CLI half of the `insforge-verify` agent skill. The full
loop an agent runs:

1. `preview create` → isolated branch backend (this command)
2. `branch switch` + apply migrations + seed verified users
3. `deployments deploy` → frontend on the branch's own https slug
4. Playwright Test Agents drive the UI
5. Backend ground-truth + cross-user RLS probes (the part only a backend platform
   can do — catches "UI looks right, backend is wrong" false passes)
6. fix → re-verify
7. `preview teardown` → branch and its branch-scoped deployment go away together

`preview create` only does step 1. **It does not deploy** — the frontend deploy is
a separate `deployments deploy` step, and it must run in branch context (see
Gotchas).

## Commands

| Command | Does |
| --- | --- |
| `preview create <name> [--wire-env [file]]` | Branch the linked project, write a manifest, optionally point a local env file at the branch backend. |
| `preview teardown <name>` | Delete the branch, restore/remove the wired env file, drop the manifest. |

Both are hidden (`{ hidden: true }`, like `orgs`/`projects`/`records`) while
experimental.

## Flow

**create:** `assertSafeName` (before anything remote) → `createBranchApi({ mode: 'full' })`
→ poll until ready → **write a baseline manifest immediately** (before any local
file mutation) → if `--wire-env`: back up the existing env file (once), rewrite
`NEXT_PUBLIC_INSFORGE_URL` to the branch backend, update the manifest with the
wired-file info.

**teardown:** `assertSafeName` → read the manifest → `deleteBranchApi(..., { ignoreNotFound: true })`
→ restore the env file from `.preview-bak` (or delete it if `preview create` created
it) → delete the manifest.

## Files

| File | Role |
| --- | --- |
| `create.ts` | `preview create` action + `pollUntilReady`. |
| `teardown.ts` | `preview teardown` action (resilient local cleanup). |
| `index.ts` | Registers the hidden `preview` parent command. |
| `../../lib/preview-manifest.ts` | `PreviewManifest` type, `assertSafeName`, read/write/delete under `.insforge/previews/<name>.json`. |
| `../../lib/env-writer.ts` | `overwriteEnvFile` — rewrites every matching `KEY=` line via a replacer function (so `$`-patterns in values are written literally). |
| `../../lib/api/platform.ts` | `deleteBranchApi(branchId, apiUrl?, { ignoreNotFound })` — passes `passThroughStatuses: [404]` when tolerating a missing branch. |

## Key design decisions

- **Manifest before local mutations.** The manifest is written right after the
  branch is ready, before any env wiring. A crash mid-wire still leaves a manifest
  that `teardown` can use — no orphaned remote branch.
- **Name validation before provisioning.** `assertSafeName` runs before
  `createBranchApi`, so a git-style name like `feat/likes` is rejected up front
  instead of orphaning a fully provisioned branch the manifest can't name.
- **Rollback on poll failure.** If provisioning never reaches ready, the branch is
  best-effort deleted so a failed create doesn't leak a branch.
- **404-tolerant teardown.** If the branch is already gone, teardown still cleans
  up the manifest and env file instead of aborting.
- **Reversible env wiring.** `--wire-env` backs up the original file to
  `.preview-bak` (never overwriting an existing backup) and records
  `wiredEnvCreated` when it created the file — so teardown restores the original or
  removes a file we created, never stranding a pointer at a deleted backend.
- **Analytics carry no free text.** `cli_preview_create` sends only
  `{ mode, parent_project_id }`, never the user-chosen name (per `DEVELOPMENT.md` §2).

## Gotchas

- **Deploy in branch context.** `preview create` does not deploy. Run
  `deployments deploy` only after `branch switch <name>` — a deploy in parent
  context targets the prod site and is not removed by `teardown`.
- **`preview create` ≠ a running frontend.** It gives you a backend (the branch).
  The frontend is a separate deploy step.

## Try it

```bash
insforge preview create my-feature --wire-env        # branch + point .env.local at it
# ... verify against the branch ...
insforge preview teardown my-feature                 # branch + env restore + manifest gone
```
