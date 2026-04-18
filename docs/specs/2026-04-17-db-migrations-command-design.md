# CLI Database Migrations

## Overview

Add developer-facing database migration commands to the InsForge CLI in the sibling `CLI` repository. These commands work against the backend custom migrations API and manage local SQL migration files under `.insforge/migrations/`.

The CLI surface is:

- `insforge db migrations list`
- `insforge db migrations fetch`
- `insforge db migrations new <migration-name>`
- `insforge db migrations up <migration-file-name-or-version>`
- `insforge db migrations up --to <migration-file-name-or-version>`
- `insforge db migrations up --all`

This is a safety-first design. Explicit single-target apply is tolerant of unrelated malformed files elsewhere in the directory, while inferred batch modes validate the whole local migration set and stop on the first issue.

## Goals

- Make remote migration history visible from the CLI.
- Sync applied remote migrations into local `.sql` files.
- Create correctly named local migration files with timestamp-based versions.
- Apply one explicit migration or a bounded batch of pending migrations.
- Keep filename rules strict and predictable.

## Non-Goals

- Rollback or `down` support.
- Local manifest/state files.
- Overwriting existing local files during `fetch`.
- Reconciling arbitrary local directory corruption automatically.

## Command Design

### `insforge db migrations list`

Fetch the current remote migration history and display:

- version
- name
- created date

Behavior:

- calls `GET /api/database/migrations`
- uses table output by default
- supports `--json`
- uses the remote order returned by the API

### `insforge db migrations fetch`

Fetch remote migration history into local files under `.insforge/migrations/`.

Behavior:

- ensures `.insforge/migrations/` exists
- calls `GET /api/database/migrations`
- writes one file per remote migration using:
  - `<migration_version>_<migration-name>.sql`
- serializes stored `statements` into SQL text by joining statements with `;\n\n`, then appending a trailing `;\n`
- if the exact target file path already exists, skip it without overwriting, even if contents differ
- supports `--json`

### `insforge db migrations new <migration-name>`

Create a new local migration file.

Input rules:

- `migration-name` must match `^[a-z0-9-]+$`
- spaces, underscores, uppercase letters, and other special characters are rejected

Version selection:

- fetch remote migration history first
- scan local `.insforge/migrations/`
- validate local filenames against the strict migration filename format
- choose the greater of:
  - current UTC timestamp formatted as `YYYYMMDDHHmmss`
  - the latest known local or remote version, incremented by one second

Safety rules for `new`:

- fail if any local migration filename is invalid
- fail if two local files use the same version
- otherwise create the next file

Filename format:

- `<migration_version>_<migration-name>.sql`

### `insforge db migrations up <target>`

Apply exactly one local migration file.

Accepted target forms:

- exact filename, such as `20260418091500_create-posts.sql`
- version, such as `20260418091500`

Resolution rules:

- if target is a filename, use that exact local file
- if target is a version, find exactly one local file with that version
- fail if there is no match
- fail if there are multiple matches for that version

Validation rules:

- target file must exist
- target filename must match the strict migration filename format
- target file must be readable
- target SQL must not be empty after trimming
- target must be newer than the latest remote migration
- target must be the next pending valid local migration after the latest remote version
- unrelated invalid local files do not block an explicit valid target

### `insforge db migrations up --to <target>`

Apply every pending local migration up to and including a chosen target.

Behavior:

- strictly validates every local migration filename first
- resolves the target version from an exact filename or bare version
- applies pending migrations in ascending version order
- stops after the chosen target migration succeeds
- fails if the target is already applied, missing, ambiguous, or not present in the pending set

### `insforge db migrations up --all`

Apply every pending local migration.

Behavior:

- strictly validates every local migration filename first
- applies pending migrations in ascending version order
- stops on the first failure

## Local File Rules

Migration directory:

- `.insforge/migrations/`

Strict filename regex:

- `^(\d{14})_([a-z0-9-]+)\.sql$`

Parsed fields:

- version: UTC timestamp in `YYYYMMDDHHmmss` format
- migration name: lowercase letters, numbers, and hyphens only

Examples:

- valid: `20260418091500_create-users.sql`
- valid: `20260418103045_add-post-index.sql`
- invalid: `20260418_create-users.sql`
- invalid: `20260418091500_create_users.sql`
- invalid: `20260418091500_CreateUsers.sql`
- invalid: `20260418091500 create-users.sql`

## API Dependencies

This CLI feature depends on the backend routes already implemented in InsForge:

- `GET /api/database/migrations`
- `POST /api/database/migrations`

Expected response fields used by the CLI:

- `version`
- `name`
- `statements`
- `createdAt`

Expected request fields used by the CLI:

- `version`
- `name`
- `sql`

## CLI Integration

Recommended structure in the sibling `CLI` repo:

- `src/commands/db/migrations.ts`
  - register the `db migrations` command group and subcommands
- `src/lib/migrations.ts`
  - filename parsing
  - local directory helpers
  - local/remote version helpers
  - SQL statement serialization for `fetch`
  - target resolution for `up`

## Output and Error Handling

Follow the current CLI conventions:

- use `outputTable` for human-readable list output
- use `outputJson` for `--json`
- use `CLIError` for user-facing failures
- use existing `ossFetch` for backend requests

Preferred error cases:

- invalid migration name
- invalid migration filename
- duplicate local migration version
- target migration file not found
- multiple local files match version
- target migration is already applied remotely
- target migration is not the next pending local migration
- target migration file is empty

## Testing

Add focused unit tests in the CLI repo for pure helpers:

- migration filename parsing
- filename validation
- local version conflict detection
- next-version selection for `new`
- target resolution for `up`
- SQL serialization for `fetch`

For command behavior, keep tests lightweight and centered on helper logic unless the repo already has a stronger command-test harness.

## Future Extensions

- rollback / `down` support
- migration templates/comments in new files
- local vs remote drift diagnostics
- checksum comparison for fetched files
