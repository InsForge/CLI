# @insforge/cli

Command line tool for the [InsForge](https://insforge.dev) platform. Manage your databases, edge functions, storage, deployments, secrets, and more — directly from the terminal.

Designed to be both human-friendly (interactive prompts, formatted tables) and agent-friendly (structured JSON output, non-interactive mode, semantic exit codes).

Requires Node.js >= 18. We recommend running via `npx` so you always get the latest version — no global install needed.

## Quick Start

```bash
# Login via browser (OAuth)
npx @insforge/cli login

# Or login with email/password
npx @insforge/cli login --email

# Check current user
npx @insforge/cli whoami

# List all organizations and projects
npx @insforge/cli list

# Link current directory to a project
npx @insforge/cli link

# Query the database
npx @insforge/cli db tables
npx @insforge/cli db query "SELECT * FROM users LIMIT 10"
```

## Authentication

If you run any command without being logged in, the CLI will automatically open your browser and start the login flow — no need to run `npx @insforge/cli login` first.

### Browser Login (default)

```bash
npx @insforge/cli login
```

Opens your browser to the InsForge authorization page using OAuth 2.0 Authorization Code + PKCE. A local callback server receives the authorization code and exchanges it for tokens. Credentials are stored in `~/.insforge/credentials.json`.

### Email/Password Login

```bash
npx @insforge/cli login --email
```

Prompts for email and password interactively, or reads from environment variables in non-interactive mode:

```bash
INSFORGE_EMAIL=user@example.com INSFORGE_PASSWORD=secret npx @insforge/cli login --email --json
```

### Logout

```bash
npx @insforge/cli logout
```

## Global Options

All commands support the following flags:

| Flag | Description |
|------|-------------|
| `--json` | Output in JSON format (useful for scripts and AI agents) |
| `--project-id <id>` | Override the linked project ID |
| `--api-url <url>` | Override the Platform API URL |
| `-y, --yes` | Skip confirmation prompts |

## Commands

### Top-Level

#### `npx @insforge/cli whoami`

Show the current authenticated user.

```bash
npx @insforge/cli whoami
npx @insforge/cli whoami --json
```

#### `npx @insforge/cli list`

List all organizations and their projects in a grouped table.

```bash
npx @insforge/cli list
npx @insforge/cli list --json
```

#### `npx @insforge/cli create`

Create a new InsForge project interactively.

```bash
npx @insforge/cli create
npx @insforge/cli create --name "my-app" --org-id <org-id> --region us-east
```

#### `npx @insforge/cli link`

Link the current directory to an InsForge project. Creates `.insforge/project.json` with the project ID, API key, and OSS host URL.

```bash
# Interactive: select from a list
npx @insforge/cli link

# Non-interactive (platform login)
npx @insforge/cli link --project-id <id> --org-id <org-id>

# OSS / self-hosted: link via host URL + API key (no platform login required)
npx @insforge/cli link \
  --api-base-url https://<app-key>.<region>.insforge.app \
  --api-key <your-project-api-key>
```

For OSS or self-hosted deployments, you can link directly using the host URL and API key — the CLI skips the platform OAuth flow and writes the credentials straight into `.insforge/project.json`. The host URL format is `https://{app_key}.{region}.insforge.app` (e.g. `https://uhzx8md3.us-east.insforge.app`).

#### `npx @insforge/cli current`

Show current CLI context (authenticated user, linked project).

```bash
npx @insforge/cli current
npx @insforge/cli current --json
```

#### `npx @insforge/cli metadata`

Show backend metadata including auth configuration, database tables, storage buckets, edge functions, AI models, and realtime channels.

```bash
npx @insforge/cli metadata
npx @insforge/cli metadata --json
```

#### `npx @insforge/cli logs`

Fetch backend container logs.

```bash
npx @insforge/cli logs <source> [options]
```

**Sources:** `insforge.logs`, `postgREST.logs`, `postgres.logs`, `function.logs`

**Options:**
- `--limit <n>`: Number of log entries to return (default: 20)

**Examples:**
```bash
npx @insforge/cli logs insforge.logs
npx @insforge/cli logs postgres.logs --limit 50
npx @insforge/cli logs function.logs --json
```

#### `npx @insforge/cli docs`

Browse InsForge SDK documentation.

```bash
npx @insforge/cli docs [feature] [language]
```

**Features:** `db`, `storage`, `functions`, `auth`, `ai`, `realtime`, `instructions`
**Languages:** `typescript`, `swift`, `kotlin`, `rest-api`

**Examples:**
```bash
# List all available docs
npx @insforge/cli docs

# Specific feature/language docs
npx @insforge/cli docs instructions           # Show backend setup instructions
npx @insforge/cli docs db typescript          # Show TypeScript database SDK docs
npx @insforge/cli docs auth swift             # Show Swift auth SDK docs
npx @insforge/cli docs storage rest-api       # Show REST API storage docs
```

---

### Database — `npx @insforge/cli db`

#### `npx @insforge/cli db query <sql>`

Execute a raw SQL query.

```bash
npx @insforge/cli db query "SELECT * FROM users LIMIT 10"
npx @insforge/cli db query "SELECT count(*) FROM orders" --json
npx @insforge/cli db query "SELECT * FROM pg_tables" --unrestricted
```

#### `npx @insforge/cli db tables`

List all database tables.

```bash
npx @insforge/cli db tables
npx @insforge/cli db tables --json
```

#### `npx @insforge/cli db functions`

List all database functions.

```bash
npx @insforge/cli db functions
```

#### `npx @insforge/cli db indexes`

List all database indexes.

```bash
npx @insforge/cli db indexes
```

#### `npx @insforge/cli db policies`

List all RLS policies.

```bash
npx @insforge/cli db policies
```

#### `npx @insforge/cli db triggers`

List all database triggers.

```bash
npx @insforge/cli db triggers
```

#### `npx @insforge/cli db rpc <functionName>`

Call a database function via RPC.

```bash
npx @insforge/cli db rpc my_function --data '{"param1": "value"}'
```

#### `npx @insforge/cli db export`

Export database schema and/or data.

```bash
npx @insforge/cli db export --output schema.sql
npx @insforge/cli db export --data-only --output data.sql
```

#### `npx @insforge/cli db import <file>`

Import database from a local SQL file.

```bash
npx @insforge/cli db import schema.sql
```

---

### Functions — `npx @insforge/cli functions`

#### `npx @insforge/cli functions list`

List all edge functions.

```bash
npx @insforge/cli functions list
npx @insforge/cli functions list --json
```

#### `npx @insforge/cli functions code <slug>`

View the source code of an edge function.

```bash
npx @insforge/cli functions code my-function
npx @insforge/cli functions code my-function --json
```

#### `npx @insforge/cli functions deploy <slug>`

Deploy an edge function. Creates the function if it doesn't exist, or updates it.

```bash
npx @insforge/cli functions deploy my-function --file ./handler.ts
npx @insforge/cli functions deploy my-function --file ./handler.ts --name "My Function" --description "Does something"
```

#### `npx @insforge/cli functions invoke <slug>`

Invoke an edge function.

```bash
npx @insforge/cli functions invoke my-function --data '{"key": "value"}'
npx @insforge/cli functions invoke my-function --method GET
npx @insforge/cli functions invoke my-function --data '{"key": "value"}' --json
```

#### `npx @insforge/cli functions delete <slug>`

Delete an edge function.

```bash
npx @insforge/cli functions delete my-function
npx @insforge/cli functions delete my-function -y  # skip confirmation
```

---

### Storage — `npx @insforge/cli storage`

#### `npx @insforge/cli storage buckets`

List all storage buckets.

```bash
npx @insforge/cli storage buckets
npx @insforge/cli storage buckets --json
```

#### `npx @insforge/cli storage create-bucket <name>`

Create a new storage bucket.

```bash
npx @insforge/cli storage create-bucket images
npx @insforge/cli storage create-bucket private-docs --private
```

#### `npx @insforge/cli storage delete-bucket <name>`

Delete a storage bucket and all its objects.

```bash
npx @insforge/cli storage delete-bucket images
npx @insforge/cli storage delete-bucket images -y   # skip confirmation
```

#### `npx @insforge/cli storage list-objects <bucket>`

List objects in a storage bucket.

```bash
npx @insforge/cli storage list-objects images
npx @insforge/cli storage list-objects images --prefix "avatars/" --limit 50
```

#### `npx @insforge/cli storage upload <file>`

Upload a file to a storage bucket.

```bash
npx @insforge/cli storage upload ./photo.png --bucket images
npx @insforge/cli storage upload ./photo.png --bucket images --key "avatars/user-123.png"
```

#### `npx @insforge/cli storage download <objectKey>`

Download a file from a storage bucket.

```bash
npx @insforge/cli storage download avatars/user-123.png --bucket images
npx @insforge/cli storage download avatars/user-123.png --bucket images --output ./downloaded.png
```

---

### Deployments — `npx @insforge/cli deployments`

#### `npx @insforge/cli deployments deploy [directory]`

Deploy a frontend project. Zips the source, uploads it, and polls for build completion (up to 2 minutes).

```bash
npx @insforge/cli deployments deploy
npx @insforge/cli deployments deploy ./my-app
npx @insforge/cli deployments deploy --env '{"API_URL": "https://api.example.com"}'
```

#### `npx @insforge/cli deployments list`

List all deployments.

```bash
npx @insforge/cli deployments list
npx @insforge/cli deployments list --limit 5 --json
```

#### `npx @insforge/cli deployments status <id>`

Get deployment details and status.

```bash
npx @insforge/cli deployments status abc-123
npx @insforge/cli deployments status abc-123 --sync   # sync status from Vercel first
```

#### `npx @insforge/cli deployments cancel <id>`

Cancel a running deployment.

```bash
npx @insforge/cli deployments cancel abc-123
```

---

### Secrets — `npx @insforge/cli secrets`

#### `npx @insforge/cli secrets list`

List all secrets (metadata only, values are hidden). Inactive (deleted) secrets are hidden by default.

```bash
npx @insforge/cli secrets list
npx @insforge/cli secrets list --all   # include inactive secrets
npx @insforge/cli secrets list --json
```

#### `npx @insforge/cli secrets get <key>`

Get the decrypted value of a secret.

```bash
npx @insforge/cli secrets get STRIPE_API_KEY
npx @insforge/cli secrets get STRIPE_API_KEY --json
```

#### `npx @insforge/cli secrets add <key> <value>`

Create a new secret.

```bash
npx @insforge/cli secrets add STRIPE_API_KEY sk_live_xxx
npx @insforge/cli secrets add STRIPE_API_KEY sk_live_xxx --reserved
npx @insforge/cli secrets add TEMP_TOKEN abc123 --expires "2025-12-31T00:00:00Z"
```

#### `npx @insforge/cli secrets update <key>`

Update an existing secret.

```bash
npx @insforge/cli secrets update STRIPE_API_KEY --value sk_live_new_xxx
npx @insforge/cli secrets update STRIPE_API_KEY --active false
npx @insforge/cli secrets update STRIPE_API_KEY --reserved true
npx @insforge/cli secrets update STRIPE_API_KEY --expires null   # remove expiration
```

#### `npx @insforge/cli secrets delete <key>`

Delete a secret (soft delete — marks as inactive).

```bash
npx @insforge/cli secrets delete STRIPE_API_KEY
npx @insforge/cli secrets delete STRIPE_API_KEY -y   # skip confirmation
```

### Schedules — `npx @insforge/cli schedules`

Manage scheduled tasks (cron jobs).

#### `npx @insforge/cli schedules list`

List all schedules in the current project.

```bash
npx @insforge/cli schedules list
npx @insforge/cli schedules list --json
```

#### `npx @insforge/cli schedules create`

Create a new scheduled task.

```bash
npx @insforge/cli schedules create --name "daily-cleanup" --cron "0 0 * * *" --url "https://api.example.com/cleanup" --method POST
npx @insforge/cli schedules create --name "hourly-sync" --cron "0 * * * *" --url "https://api.example.com/sync" --method GET --headers '{"Authorization": "Bearer xxx"}'
```

#### `npx @insforge/cli schedules get <id>`

Get details of a specific schedule.

```bash
npx @insforge/cli schedules get <id>
npx @insforge/cli schedules get 123 --json
```

#### `npx @insforge/cli schedules update <id>`

Update an existing schedule.

```bash
npx @insforge/cli schedules update <id> --name "weekly-cleanup" --cron "0 0 * * 0"
npx @insforge/cli schedules update 123 --active false
```

#### `npx @insforge/cli schedules delete <id>`

Delete a schedule.

```bash
npx @insforge/cli schedules delete <id>
npx @insforge/cli schedules delete 123 -y
```

#### `npx @insforge/cli schedules logs <id>`

Fetch execution logs for a specific schedule.

```bash
npx @insforge/cli schedules logs <id>
npx @insforge/cli schedules logs 123 --limit 100
```

---

## Project Configuration

Running `npx @insforge/cli link` creates a `.insforge/` directory in your project:

```
.insforge/
└── project.json    # project_id, org_id, appkey, region, api_key, oss_host
```

Add `.insforge/` to your `.gitignore` — it contains your project API key.

Global configuration is stored in `~/.insforge/`:

```
~/.insforge/
├── credentials.json    # access_token, refresh_token, user profile
└── config.json         # default_org_id, platform_api_url
```

## Agent Skills

When you run `npx @insforge/cli create` or `npx @insforge/cli link`, the CLI automatically installs a set of [InsForge agent skills](https://github.com/InsForge/agent-skills) into your project for all supported AI coding agents (Claude Code, Cursor, Windsurf, Cline, Roo, Gemini CLI, GitHub Copilot, Qwen, Qoder, Trae, Kilo, Codex, Augment, Antigravity). These skills teach your coding agent how to work with InsForge — database queries, auth, storage, edge functions, realtime, etc. — so it can generate correct code for your backend without you copy-pasting docs.

It also installs [`find-skills`](https://github.com/vercel-labs/skills) so agents can discover available skills on demand.

Skill files are written to per-agent directories (e.g. `.claude/`, `.cursor/`, `.windsurf/`) and are automatically added to your `.gitignore`. You can re-run `npx @insforge/cli link` at any time to reinstall or update skills.

### `insforge skills` — manage bundled Claude skills

In addition to the `npx skills add …` flow above (which covers a wide set of agents), `@insforge/cli` ships a small set of InsForge skill files bundled directly inside the npm package. You can manage them with the `insforge skills` command family:

```bash
# Show installed + bundled-but-not-installed skills
npx @insforge/cli skills list

# Install every bundled skill into ~/.claude/skills/insforge-<slug>/
npx @insforge/cli skills install

# Install one specific skill (by slug)
npx @insforge/cli skills install database

# Re-copy from the bundle, overwriting any local edits
npx @insforge/cli skills update

# Keep local edits; update only the ones you haven't touched
npx @insforge/cli skills update --keep-local

# Remove an installed skill
npx @insforge/cli skills uninstall database
```

By default skills are installed to `~/.claude/skills/insforge-<slug>/`. You can override the target directory with either of the following environment variables (in precedence order):

| Variable | Effect |
|----------|--------|
| `CLAUDE_CONFIG_DIR` | Installs under `<CLAUDE_CONFIG_DIR>/skills/` |
| `XDG_CONFIG_HOME` | Installs under `<XDG_CONFIG_HOME>/claude/skills/` |

If neither is set, the default `~/.claude/skills/` is used. All commands also accept `--target-dir <path>` as an explicit override.

If you ran `npx @insforge/cli skills install` from a local source build and see a "No skills bundled" warning, run `npm run build:skills` (or install `@insforge/cli` from npm — the bundled skills ship in the published tarball).

## Analytics

The CLI reports anonymous usage events to [PostHog](https://posthog.com) so we can understand which features are being used and prioritize improvements. 

Analytics are enabled by default in the published npm package. If you build the CLI from source without setting `POSTHOG_API_KEY` at build time, analytics become a no-op automatically.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `INSFORGE_ACCESS_TOKEN` | Override the stored access token |
| `INSFORGE_PROJECT_ID` | Override the linked project ID |
| `INSFORGE_API_URL` | Override the Platform API URL |
| `INSFORGE_EMAIL` | Email for non-interactive login |
| `INSFORGE_PASSWORD` | Password for non-interactive login |

## Non-Interactive / CI Usage

All commands support `--json` for structured output and `-y` to skip confirmation prompts:

```bash
# Login in CI
INSFORGE_EMAIL=$EMAIL INSFORGE_PASSWORD=$PASSWORD npx @insforge/cli login --email --json

# Link a project
npx @insforge/cli link --project-id $PROJECT_ID --org-id $ORG_ID -y

# Query and pipe results
npx @insforge/cli db query "SELECT * FROM users" --json | jq '.rows[].email'

# Deploy frontend
npx @insforge/cli deployments deploy ./dist --json

# Upload a build artifact
npx @insforge/cli storage upload ./dist/bundle.js --bucket assets --key "v1.2.0/bundle.js" --json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Authentication failure |
| 3 | Project not linked (run `npx @insforge/cli link` first) |
| 4 | Resource not found |
| 5 | Permission denied |

## Development

```bash
git clone <repo-url>
cd insforge-CLI
npm install
npm run build
npm link        # makes `insforge` available globally

npm run dev     # watch mode for development
```

### Testing

#### Unit tests

```bash
npm run test:unit
```

#### Real project integration tests

Run locally:

```bash
INTEGRATION_TEST_ENABLED=true \
INTEGRATION_LOG_SOURCE=insforge.logs \
npm run test:integration:real
```

Prerequisites:
- Logged in (`npx @insforge/cli login`) so `~/.insforge/credentials.json` exists
- Linked project in this repo (`npx @insforge/cli link`) so `.insforge/project.json` exists

Optional environment variables:
- `INSFORGE_API_URL`: Platform API URL override (defaults to `https://api.insforge.dev`)
- `INTEGRATION_LOG_SOURCE`: Log source for `logs` test (default `insforge.logs`)

Current real-project checks:
- `whoami --json`
- `metadata --json`
- `logs <source> --json`
- `docs instructions --json`

## Releasing

Bump the version, push the tag, and create a GitHub Release — the CI will publish to npm automatically.

```bash
# Bump version (creates commit + tag)
npm version patch   # 0.1.3 → 0.1.4
# or
npm version minor   # 0.1.3 → 0.2.0

# Push commit and tag
git push && git push --tags
```

Then go to GitHub → Releases → **Draft a new release**, select the tag (e.g. `v0.1.4`), and publish. The [publish workflow](.github/workflows/publish.yml) will run `npm publish` automatically.

## License

Apache-2.0
