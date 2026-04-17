# CLI Database Migrations

## Overview

Add developer-facing database migration commands to the InsForge CLI in the sibling `CLI` repository. These commands should work against the existing backend custom migrations API and manage local SQL migration files under `.insforge/migrations/`.

The CLI surface is:

- `insforge db migrations list`
- `insforge db migrations fetch`
- `insforge db migrations new <migration-name>`
- `insforge db migrations up <migration-file-name-or-sequence-number>`

This is a safety-first V1. The CLI should stop when target resolution is ambiguous or when command-specific validation fails, rather than trying to infer intent.

## Goals

- Make remote migration history visible from the CLI.
- Sync applied remote migrations into local `.sql` files.
- Create correctly named local migration files with the next sequence number.
- Apply exactly one local migration file at a time.
- Keep filename rules strict and predictable.

## Non-Goals

- Bulk `up all` support.
- Rollback or `down` support.
- Local manifest/state files.
- Overwriting existing local files during `fetch`.
- Reconciling arbitrary local directory corruption automatically.

## Command Design

### `insforge db migrations list`

Fetch the current remote migration history and display:

- sequence number
- name
- created date

Behavior:

- calls `GET /api/database/migrations`
- uses table output by default
- supports `--json`
- sorts in remote order returned by the API

## `insforge db migrations fetch`

Fetch remote migration history into local files under `.insforge/migrations/`.

Behavior:

- ensures `.insforge/migrations/` exists
- calls `GET /api/database/migrations`
- writes one file per remote migration using:
  - `<sequence_number>_<migration-name>.sql`
- serializes stored `statements` into SQL text by joining statements with `;\n\n`, then appending a trailing `;\n`
- if the exact target file path already exists, skip it without overwriting, even if contents differ
- supports `--json`

Output should summarize:

- total remote migrations
- created files
- skipped files

## `insforge db migrations new <migration-name>`

Create a new local migration file.

Input rules:

- `migration-name` must match `^[a-z0-9-]+$`
- spaces, underscores, uppercase letters, and other special characters are rejected

Sequence selection:

- fetch remote migration history first
- scan local `.insforge/migrations/`
- validate local filenames against the strict migration filename format
- compute the next sequence number from the validated local chain after the latest remote sequence

Safety rules for `new`:

- fail if any local migration filename is invalid
- fail if two local files use the same sequence number
- fail if local pending migrations after the latest remote sequence are not contiguous
- otherwise create the next file

Filename format:

- `<migration_sequence_number>_<migration-name>.sql`

Example:

- remote latest: `5`
- local pending: `6_create-users.sql`, `7_add-user-index.sql`
- `insforge db migrations new create-posts`
- creates `8_create-posts.sql`

File contents:

- create an empty file

## `insforge db migrations up <target>`

Apply exactly one local migration file.

Accepted target forms:

- exact filename, such as `8_create-posts.sql`
- sequence number, such as `8`

Resolution rules:

- if target is a filename, use that exact local file
- if target is a sequence number, find exactly one local file with that sequence
- fail if there is no match
- fail if there are multiple matches for that sequence

Validation rules:

- target file must exist
- target filename must match the strict migration filename format
- target file must be readable
- target SQL must not be empty after trimming
- target sequence must equal `latest remote sequence + 1`
- if the target sequence is already applied remotely, fail instead of skipping

Important safety boundary:

- `up` validates the target and target ambiguity only
- unrelated invalid local files elsewhere in `.insforge/migrations/` must not block applying an explicit valid target

Execution flow:

1. load remote migrations via `GET /api/database/migrations`
2. resolve target file from filename or sequence number
3. parse sequence number and migration name from filename
4. read SQL from file
5. call `POST /api/database/migrations` with:
   - `name`: parsed migration name
   - `sql`: file contents
6. verify the response `sequenceNumber` matches the filename sequence
7. print success output

## Local File Rules

Migration directory:

- `.insforge/migrations/`

Strict filename regex:

- `^([1-9][0-9]*)_([a-z0-9-]+)\.sql$`

Parsed fields:

- sequence number: positive base-10 integer with no leading sign
- migration name: lowercase letters, numbers, and hyphens only

Examples:

- valid: `1_create-users.sql`
- valid: `12_add-post-index.sql`
- invalid: `01_create-users.sql`
- invalid: `1_create_users.sql`
- invalid: `1_CreateUsers.sql`
- invalid: `1 create-users.sql`

## API Dependencies

This CLI feature depends on the backend routes already implemented in InsForge:

- `GET /api/database/migrations`
- `POST /api/database/migrations`

Expected response fields used by the CLI:

- `sequenceNumber`
- `name`
- `statements`
- `createdAt`

## CLI Integration

Recommended structure in the sibling `CLI` repo:

- `src/commands/db/migrations.ts`
  - register the `db migrations` command group and subcommands
- `src/lib/migrations.ts`
  - filename parsing
  - local directory helpers
  - remote/local sequence helpers
  - SQL statement serialization for `fetch`
  - target resolution for `up`

Register the new group under the existing `db` command namespace in `src/index.ts`.

## Output and Error Handling

Follow the current CLI conventions:

- use `outputTable` for human-readable list output
- use `outputJson` for `--json`
- use `CLIError` for user-facing failures
- use existing `ossFetch` for backend requests

Preferred error cases:

- invalid migration name
- invalid migration filename
- duplicate local migration sequence
- non-contiguous local pending migrations for `new`
- target migration file not found
- multiple local files match sequence
- target migration is not the next remote sequence
- target migration file is empty

## Testing

Add focused unit tests in the CLI repo for pure helpers:

- migration filename parsing
- filename validation
- local sequence conflict detection
- contiguous pending-chain validation for `new`
- target resolution for `up`
- SQL serialization for `fetch`

For command behavior, keep tests lightweight and centered on helper logic unless the repo already has a stronger command-test harness.

## Future Extensions

- `insforge db migrations up --all`
- `insforge db migrations down`
- migration templates/comments in new files
- local vs remote drift diagnostics
- checksum comparison for fetched files
