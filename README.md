# @insforge/cli

Command line tool for the [InsForge](https://insforge.dev) platform. Manage your databases, edge functions, storage, deployments, secrets, and more — directly from the terminal.

Designed to be both human-friendly (interactive prompts, formatted tables) and agent-friendly (structured JSON output, non-interactive mode, semantic exit codes).

## Installation

```bash
npm install -g @insforge/cli
```

Requires Node.js >= 18.

## Quick Start

```bash
# Login via browser (OAuth)
insforge login

# Or login with email/password
insforge login --email

# Check current user
insforge whoami

# List all organizations and projects
insforge list

# Link current directory to a project
insforge link

# Query the database
insforge db tables
insforge db query "SELECT * FROM users LIMIT 10"
```

## Authentication

If you run any command without being logged in, the CLI will automatically open your browser and start the login flow — no need to run `insforge login` first.

### Browser Login (default)

```bash
insforge login
```

Opens your browser to the InsForge authorization page using OAuth 2.0 Authorization Code + PKCE. A local callback server receives the authorization code and exchanges it for tokens. Credentials are stored in `~/.insforge/credentials.json`.

### Email/Password Login

```bash
insforge login --email
```

Prompts for email and password interactively, or reads from environment variables in non-interactive mode:

```bash
INSFORGE_EMAIL=user@example.com INSFORGE_PASSWORD=secret insforge login --email --json
```

### Logout

```bash
insforge logout
```

## Real Project Integration Tests (Issue #19 Phase 1)

This repository includes a real-project integration suite for read-only checks.

Run locally:

```bash
INTEGRATION_TEST_ENABLED=true \
INSFORGE_API_URL=https://api.insforge.dev \
INTEGRATION_LOG_SOURCE=insforge.logs \
npm run test:integration:real
```

Prerequisites:
- Logged in (`insforge login`) so `~/.insforge/credentials.json` exists
- Linked project in this repo (`insforge link`) so `.insforge/project.json` exists

Optional environment variables:
- `INSFORGE_API_URL`: Platform API URL override (defaults to `https://api.insforge.dev`)
- `INTEGRATION_LOG_SOURCE`: Log source for `logs` test (default `insforge.logs`)

The suite currently validates read-only flows:
- `whoami --json`
- `metadata --json`
- `logs <source> --json`
- `docs instructions --json`

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

#### `insforge whoami`

Show the current authenticated user.

```bash
insforge whoami
insforge whoami --json
```

#### `insforge list`

List all organizations and their projects in a grouped table.

```bash
insforge list
insforge list --json
```

#### `insforge create`

Create a new InsForge project interactively.

```bash
insforge create
insforge create --name "my-app" --org-id <org-id> --region us-east
```

#### `insforge link`

Link the current directory to an InsForge project. Creates `.insforge/project.json` with the project ID, API key, and OSS host URL.

```bash
# Interactive: select from a list
insforge link

# Non-interactive
insforge link --project-id <id> --org-id <org-id>
```

#### `insforge current`

Show current CLI context (authenticated user, linked project).

```bash
insforge current
insforge current --json
```

#### `insforge metadata`

Show backend metadata including auth configuration, database tables, storage buckets, edge functions, AI models, and realtime channels.

```bash
insforge metadata
insforge metadata --json
```

#### `insforge logs`

Fetch backend container logs.

```bash
insforge logs <source> [options]
```

**Sources:** `insforge.logs`, `postgREST.logs`, `postgres.logs`, `function.logs`

**Options:**
- `--limit <n>`: Number of log entries to return (default: 20)

**Examples:**
```bash
insforge logs insforge.logs
insforge logs postgres.logs --limit 50
insforge logs function.logs --json
```

#### `insforge docs`

Browse InsForge SDK documentation.

```bash
insforge docs [feature] [language]
```

**Features:** `db`, `storage`, `functions`, `auth`, `ai`, `realtime`, `instructions`
**Languages:** `typescript`, `swift`, `kotlin`, `rest-api`

**Examples:**
```bash
# List all available docs
insforge docs

# Specific feature/language docs
insforge docs instructions           # Show backend setup instructions
insforge docs db typescript          # Show TypeScript database SDK docs
insforge docs auth swift             # Show Swift auth SDK docs
insforge docs storage rest-api       # Show REST API storage docs
```

---

### Database — `insforge db`

#### `insforge db query <sql>`

Execute a raw SQL query.

```bash
insforge db query "SELECT * FROM users LIMIT 10"
insforge db query "SELECT count(*) FROM orders" --json
insforge db query "SELECT * FROM pg_tables" --unrestricted
```

#### `insforge db tables`

List all database tables.

```bash
insforge db tables
insforge db tables --json
```

#### `insforge db functions`

List all database functions.

```bash
insforge db functions
```

#### `insforge db indexes`

List all database indexes.

```bash
insforge db indexes
```

#### `insforge db policies`

List all RLS policies.

```bash
insforge db policies
```

#### `insforge db triggers`

List all database triggers.

```bash
insforge db triggers
```

#### `insforge db rpc <functionName>`

Call a database function via RPC.

```bash
insforge db rpc my_function --data '{"param1": "value"}'
```

#### `insforge db export`

Export database schema and/or data.

```bash
insforge db export --output schema.sql
insforge db export --data-only --output data.sql
```

#### `insforge db import <file>`

Import database from a local SQL file.

```bash
insforge db import schema.sql
```

---

### Functions — `insforge functions`

#### `insforge functions list`

List all edge functions.

```bash
insforge functions list
insforge functions list --json
```

#### `insforge functions code <slug>`

View the source code of an edge function.

```bash
insforge functions code my-function
insforge functions code my-function --json
```

#### `insforge functions deploy <slug>`

Deploy an edge function. Creates the function if it doesn't exist, or updates it.

```bash
insforge functions deploy my-function --file ./handler.ts
insforge functions deploy my-function --file ./handler.ts --name "My Function" --description "Does something"
```

#### `insforge functions invoke <slug>`

Invoke an edge function.

```bash
insforge functions invoke my-function --data '{"key": "value"}'
insforge functions invoke my-function --method GET
insforge functions invoke my-function --data '{"key": "value"}' --json
```

#### `insforge functions delete <slug>`

Delete an edge function.

```bash
insforge functions delete my-function
insforge functions delete my-function -y  # skip confirmation
```

---

### Storage — `insforge storage`

#### `insforge storage buckets`

List all storage buckets.

```bash
insforge storage buckets
insforge storage buckets --json
```

#### `insforge storage create-bucket <name>`

Create a new storage bucket.

```bash
insforge storage create-bucket images
insforge storage create-bucket private-docs --private
```

#### `insforge storage delete-bucket <name>`

Delete a storage bucket and all its objects.

```bash
insforge storage delete-bucket images
insforge storage delete-bucket images -y   # skip confirmation
```

#### `insforge storage list-objects <bucket>`

List objects in a storage bucket.

```bash
insforge storage list-objects images
insforge storage list-objects images --prefix "avatars/" --limit 50
```

#### `insforge storage upload <file>`

Upload a file to a storage bucket.

```bash
insforge storage upload ./photo.png --bucket images
insforge storage upload ./photo.png --bucket images --key "avatars/user-123.png"
```

#### `insforge storage download <objectKey>`

Download a file from a storage bucket.

```bash
insforge storage download avatars/user-123.png --bucket images
insforge storage download avatars/user-123.png --bucket images --output ./downloaded.png
```

---

### Deployments — `insforge deployments`

#### `insforge deployments deploy [directory]`

Deploy a frontend project. Zips the source, uploads it, and polls for build completion (up to 2 minutes).

```bash
insforge deployments deploy
insforge deployments deploy ./my-app
insforge deployments deploy --env '{"API_URL": "https://api.example.com"}'
```

#### `insforge deployments list`

List all deployments.

```bash
insforge deployments list
insforge deployments list --limit 5 --json
```

#### `insforge deployments status <id>`

Get deployment details and status.

```bash
insforge deployments status abc-123
insforge deployments status abc-123 --sync   # sync status from Vercel first
```

#### `insforge deployments cancel <id>`

Cancel a running deployment.

```bash
insforge deployments cancel abc-123
```

---

### Secrets — `insforge secrets`

#### `insforge secrets list`

List all secrets (metadata only, values are hidden). Inactive (deleted) secrets are hidden by default.

```bash
insforge secrets list
insforge secrets list --all   # include inactive secrets
insforge secrets list --json
```

#### `insforge secrets get <key>`

Get the decrypted value of a secret.

```bash
insforge secrets get STRIPE_API_KEY
insforge secrets get STRIPE_API_KEY --json
```

#### `insforge secrets add <key> <value>`

Create a new secret.

```bash
insforge secrets add STRIPE_API_KEY sk_live_xxx
insforge secrets add STRIPE_API_KEY sk_live_xxx --reserved
insforge secrets add TEMP_TOKEN abc123 --expires "2025-12-31T00:00:00Z"
```

#### `insforge secrets update <key>`

Update an existing secret.

```bash
insforge secrets update STRIPE_API_KEY --value sk_live_new_xxx
insforge secrets update STRIPE_API_KEY --active false
insforge secrets update STRIPE_API_KEY --reserved true
insforge secrets update STRIPE_API_KEY --expires null   # remove expiration
```

#### `insforge secrets delete <key>`

Delete a secret (soft delete — marks as inactive).

```bash
insforge secrets delete STRIPE_API_KEY
insforge secrets delete STRIPE_API_KEY -y   # skip confirmation
```

### Schedules — `insforge schedules`

Manage scheduled tasks (cron jobs).

#### `insforge schedules list`

List all schedules in the current project.

```bash
insforge schedules list
insforge schedules list --json
```

#### `insforge schedules create`

Create a new scheduled task.

```bash
insforge schedules create --name "daily-cleanup" --cron "0 0 * * *" --url "https://api.example.com/cleanup" --method POST
insforge schedules create --name "hourly-sync" --cron "0 * * * *" --url "https://api.example.com/sync" --method GET --headers '{"Authorization": "Bearer xxx"}'
```

#### `insforge schedules get <id>`

Get details of a specific schedule.

```bash
insforge schedules get <id>
insforge schedules get 123 --json
```

#### `insforge schedules update <id>`

Update an existing schedule.

```bash
insforge schedules update <id> --name "weekly-cleanup" --cron "0 0 * * 0"
insforge schedules update 123 --active false
```

#### `insforge schedules delete <id>`

Delete a schedule.

```bash
insforge schedules delete <id>
insforge schedules delete 123 -y
```

#### `insforge schedules logs <id>`

Fetch execution logs for a specific schedule.

```bash
insforge schedules logs <id>
insforge schedules logs 123 --limit 100
```

---

## Project Configuration

Running `insforge link` creates a `.insforge/` directory in your project:

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
INSFORGE_EMAIL=$EMAIL INSFORGE_PASSWORD=$PASSWORD insforge login --email --json

# Link a project
insforge link --project-id $PROJECT_ID --org-id $ORG_ID -y

# Query and pipe results
insforge db query "SELECT * FROM users" --json | jq '.rows[].email'

# Deploy frontend
insforge deployments deploy ./dist --json

# Upload a build artifact
insforge storage upload ./dist/bundle.js --bucket assets --key "v1.2.0/bundle.js" --json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Authentication failure |
| 3 | Project not linked (run `insforge link` first) |
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
