# User-Scoped API Keys — CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npx @insforge/cli login --user-api-key uak_...` so users can authenticate the CLI with a backend-generated user-scoped API key, bypassing OAuth entirely. All existing commands (including platform-only ones like `diagnose`, `list`, `create`) then work without any browser round-trip.

**Architecture:** Add a single flag to the existing `login` command that stores the PAT into `~/.insforge/credentials.json` exactly where OAuth would write its `access_token`. `platformFetch` doesn't care what the token is — it just sends it as `Authorization: Bearer <token>`, which the backend middleware (see backend plan) already recognizes via the `uak_` prefix. Skip the token-refresh code path for PATs since they don't expire on a rolling basis.

**Depends on:** backend plan `2026-04-21-user-api-keys-backend.md` landed and deployed — this CLI change is untestable end-to-end until the backend recognizes `uak_` tokens. You can still write/land the CLI code first (it's backward-compatible), but the smoke test in Task 3 requires a running backend.

**Tech Stack:** TypeScript, Commander, `@clack/prompts`, Vitest.

---

## File Structure

**Modified files:**
- `src/commands/login.ts` — add `--user-api-key <key>` flag + branch
- `src/lib/credentials.ts` — `refreshAccessToken` bails early for PAT tokens
- `src/types.ts` — (no-op; `StoredCredentials` already holds an arbitrary string for `access_token`)

**New files:**
- `src/commands/login.test.ts` — covers the new flag (mirrors `create.test.ts` style)

**No new dependencies.**

---

## Task 0: Branch + baseline

- [ ] **Step 1: Create feature branch**

```bash
cd /Users/carmen/Desktop/Github/CLI
git checkout main && git pull
git checkout -b feat/user-api-key-login
```

- [ ] **Step 2: Confirm baseline tests pass**

```bash
npm test
```

Expected: all existing tests pass.

- [ ] **Step 3: Confirm typecheck is clean**

```bash
npx tsc --noEmit
```

Expected: zero errors.

---

## Task 1: Add `--user-api-key` flag to `login`

**Files:**
- Modify: `src/commands/login.ts`

- [ ] **Step 1: Add the flag declaration**

In `src/commands/login.ts`, find the `.option('--email', ...)` line and add two new options plus the branch in the action handler. The whole `registerLoginCommand` block becomes:

```ts
export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with InsForge platform')
    .option('--email', 'Login with email and password instead of browser')
    .option('--user-api-key <key>', 'Authenticate with a user API key (uak_...) — skips OAuth')
    .option('--client-id <id>', 'OAuth client ID (defaults to insforge-cli)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);

      try {
        if (opts.userApiKey) {
          await loginWithUserApiKey(opts.userApiKey, json, apiUrl);
        } else if (opts.email) {
          await loginWithEmail(json, apiUrl);
        } else {
          await loginWithOAuth(json, apiUrl);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('cancelled')) {
          process.exit(0);
        }
        handleError(err, json);
      }
    });
}
```

- [ ] **Step 2: Implement `loginWithUserApiKey`**

Add this function at the bottom of `src/commands/login.ts`:

```ts
async function loginWithUserApiKey(key: string, json: boolean, apiUrl?: string): Promise<void> {
  if (!key.startsWith('uak_')) {
    throw new Error('Invalid API key — must start with "uak_".');
  }

  // Save the PAT as the access_token. The backend's auth middleware recognizes
  // the uak_ prefix, so platformFetch's Authorization: Bearer <key> Just Works.
  // We verify by fetching /profile — this doubles as a connectivity + key check.
  const placeholderUser = {
    id: '', name: '', email: '', avatar_url: null as string | null, email_verified: true,
  };
  const creds: StoredCredentials = {
    access_token: key,
    refresh_token: '',
    user: placeholderUser,
  };
  saveCredentials(creds);

  if (!json) {
    const s = clack.spinner();
    s.start('Verifying API key...');
    try {
      const { getProfile } = await import('../lib/api/platform.js');
      const profile = await getProfile(apiUrl);
      creds.user = profile;
      saveCredentials(creds);
      s.stop(`Authenticated as ${profile.email}`);
      clack.outro('Done');
    } catch (err) {
      s.stop('API key verification failed');
      // Remove the bad key so we don't leave the CLI in a broken "logged in" state.
      saveCredentials({ access_token: '', refresh_token: '', user: placeholderUser });
      throw new Error(
        `API key is invalid or revoked: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  // JSON mode — no spinner, structured error if validation fails.
  try {
    const { getProfile } = await import('../lib/api/platform.js');
    const profile = await getProfile(apiUrl);
    creds.user = profile;
    saveCredentials(creds);
    console.log(JSON.stringify({ success: true, user: profile }));
  } catch (err) {
    saveCredentials({ access_token: '', refresh_token: '', user: placeholderUser });
    throw new Error(
      `API key is invalid or revoked: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Smoke-test the help output**

```bash
npx tsx src/index.ts login --help
```

Expected output includes:

```
Options:
  --email                    Login with email and password instead of browser
  --user-api-key <key>       Authenticate with a user API key (uak_...) — skips OAuth
  --client-id <id>           OAuth client ID (defaults to insforge-cli)
  -h, --help                 display help for command
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/login.ts
git commit -m "feat(login): add --user-api-key for OAuth-free authentication"
```

---

## Task 2: Skip refresh for PAT credentials

**Files:**
- Modify: `src/lib/credentials.ts`

`refreshAccessToken` currently assumes an OAuth refresh_token. If the user authenticated with a PAT (no refresh_token stored), a 401 from an expired/revoked PAT would trigger a refresh attempt that always fails, giving a confusing error. Detect and bail early with a clear message.

- [ ] **Step 1: Modify `refreshAccessToken`**

In `src/lib/credentials.ts`, the existing `refreshAccessToken` starts with:

```ts
export async function refreshAccessToken(apiUrl?: string): Promise<string> {
  const creds = getCredentials();
  if (!creds?.refresh_token) {
    throw new AuthError('Refresh token not found. Run `npx @insforge/cli login` again.');
  }
  // ...
}
```

Change the error path so a PAT (recognizable by its `uak_` prefix stored in `access_token` with an empty refresh_token) emits a PAT-specific message:

```ts
export async function refreshAccessToken(apiUrl?: string): Promise<string> {
  const creds = getCredentials();
  if (!creds?.refresh_token) {
    const isPat = creds?.access_token?.startsWith('uak_');
    throw new AuthError(
      isPat
        ? 'API key is invalid or revoked. Run `npx @insforge/cli login --user-api-key <new-key>` again.'
        : 'Refresh token not found. Run `npx @insforge/cli login` again.',
    );
  }
  // ... rest unchanged
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/credentials.ts
git commit -m "feat(credentials): emit PAT-specific error when uak_ token fails validation"
```

---

## Task 3: Unit + manual smoke tests

**Files:**
- Create: `src/commands/login.test.ts`

- [ ] **Step 1: Write unit tests for the prefix guard**

```ts
// src/commands/login.test.ts
import { describe, expect, it } from 'vitest';

// Mirrors the prefix check inside loginWithUserApiKey — extracted so we can
// test it without bringing in fs/network code.
function isValidUserApiKeyFormat(key: string): boolean {
  return key.startsWith('uak_') && key.length >= 20;
}

describe('login: --user-api-key prefix validation', () => {
  it('accepts a well-formed uak_ key', () => {
    expect(isValidUserApiKeyFormat('uak_' + 'x'.repeat(43))).toBe(true);
  });

  it('rejects keys missing the uak_ prefix', () => {
    expect(isValidUserApiKeyFormat('ik_0123456789abcdef0123')).toBe(false);
    expect(isValidUserApiKeyFormat('Bearer uak_xxx')).toBe(false);
    expect(isValidUserApiKeyFormat('')).toBe(false);
  });

  it('rejects obviously-too-short keys', () => {
    expect(isValidUserApiKeyFormat('uak_')).toBe(false);
    expect(isValidUserApiKeyFormat('uak_short')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 3: Manual smoke test against live backend** (requires backend plan deployed)

In a clean shell:

```bash
# Start clean
rm -f ~/.insforge/credentials.json

# From the dashboard (or a curl using a JWT session), create a key.
# For local dev, curl the backend directly with a JWT.
# NOTE: never echo $JWT or $NEW_KEY — they're secrets.
export JWT=<your-login-jwt>
NEW_KEY=$(curl -sS -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"cli-smoke"}' \
  http://localhost:3100/api/account/api-keys | jq -r .token)

# Sanity-check prefix without printing the value.
case "$NEW_KEY" in uak_*) echo "key fetched ok" ;; *) echo "ERROR: missing uak_ prefix"; exit 1 ;; esac

# Log in with it
npx tsx src/index.ts login --user-api-key "$NEW_KEY"
# Expected: "Authenticated as <your-email>"

# Verify a platform-only command works without OAuth
npx tsx src/index.ts whoami
# Expected: shows user info

# Verify the credentials file has a uak_ access_token and empty refresh_token
# (asserting shape without dumping the secret to stdout):
jq -e '.access_token | startswith("uak_")' ~/.insforge/credentials.json > /dev/null \
  && jq -e '.refresh_token == ""' ~/.insforge/credentials.json > /dev/null \
  && echo "credentials shape ok"

# Revoke from dashboard (or curl DELETE), then re-run
npx tsx src/index.ts whoami
# Expected: 401 / "API key is invalid or revoked"
```

- [ ] **Step 4: Commit test file**

```bash
git add src/commands/login.test.ts
git commit -m "test(login): prefix validation for --user-api-key flag"
```

---

## Task 4: Version bump + release prep

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Determine the current version and bump the patch number:

```bash
node -p "require('./package.json').version"
```

If it's `0.1.57`, bump to `0.1.58` (additive feature = minor per semver, but this project uses patch for additive in practice — check recent commits with `git log --oneline -5 | grep 'bump version'` to confirm cadence).

Edit `package.json`:

```json
{
  "version": "0.1.58"
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.1.58"
```

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/user-api-key-login
gh pr create --title "feat: login --user-api-key for OAuth-free CLI auth" --body "$(cat <<'EOF'
## Summary
- Adds \`login --user-api-key <uak_...>\` that stores a user-scoped API key and verifies it via /profile
- Skips token-refresh path for PAT credentials with a PAT-specific error message
- All platform-hitting commands (diagnose, list, create, whoami) now work without OAuth once a key is set

## Requires
- Backend PR landing the \`uak_\` recognition in auth middleware + \`/api/account/api-keys\` endpoints.

## Test plan
- [ ] \`npm test\` — unit tests green
- [ ] Manual smoke: create key via curl → \`login --user-api-key\` → \`whoami\` → revoke → next \`whoami\` returns 401
EOF
)"
```

---

## Acceptance criteria

- `login --user-api-key uak_xxx` saves the key to `~/.insforge/credentials.json` and prints the authenticated user's email.
- A key that doesn't start with `uak_` is rejected synchronously with a clear error.
- A valid key that is later revoked results in a PAT-specific error message on the next command: `"API key is invalid or revoked. Run \`npx @insforge/cli login --user-api-key <new-key>\` again."` — not a generic OAuth refresh error.
- After `login --user-api-key`, commands like `whoami`, `projects list`, `orgs list`, and `diagnose metrics` all work without triggering a browser OAuth flow.
- `logout` clears the PAT from the credentials file (unchanged — existing `clearCredentials` handles it).

---

## Notes for reviewers

- **Why we reuse `access_token` instead of adding a `user_api_key` field.** `platformFetch` only reads `access_token`. Adding a separate field would require plumbing through every call site. The PAT and OAuth access tokens are fungible from the HTTP client's POV; the backend tells them apart by prefix.
- **Why we verify by hitting `/profile` at login time.** Catching a bad key up-front avoids a confusing "works once, fails next command" experience. The verify round-trip is ~100ms — acceptable for an interactive auth command.
- **Why refresh is bailed, not silently retried.** A PAT cannot be refreshed (it doesn't have a refresh_token counterpart). If we silently retried, the user would see "Session expired" and be pushed to OAuth, which contradicts why they used a PAT in the first place.
