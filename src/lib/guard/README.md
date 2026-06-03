# Human-in-the-loop guard (POC)

Stops dangerous InsForge CLI operations for human approval **before** they run.
It lives inside the `insforge` binary as a Commander `preAction` stage — not in
any agent's harness — so it protects **every** caller automatically: Claude
Code, Cursor, custom agents, scripts, CI, and humans. The caller's process
blocks on a localhost approval page until a human clicks Approve or Deny.

## Two responsibilities, two trust levels

- **Whether to stop = hard rules, in the CLI.** Deterministic, fast, trustworthy.
  An agent can never downgrade a `DROP`. This is the authoritative verdict.
- **The human explanation = the calling agent.** The agent is already an LLM with
  the most context about *why* it's running the command. It passes a structured
  brief — intent, implications, recommendation — via `--reason` / `--impact` /
  `--recommendation`. The CLI makes **no LLM call of its own** — no keys to
  configure, works for any agent. The agent can explain, but it **cannot change
  the verdict**.

## Encouraging the agent to think (the nudge)

The CLI actively pushes the calling LLM to articulate its intent rather than
silently bouncing a human a bare command. When a destructive op has **no brief**
and the caller is **non-interactive** (an agent or CI — detected via no TTY), the
guard does **not** open the page. Instead it prints a copy-paste-ready
instruction to re-run *with* `--reason` / `--impact` / `--recommendation`, and
exits **2** (`needs_brief`). The agent reasons about the implications, re-runs
with the brief, and *then* the human sees a readable approval page.

A human at a TTY (or `INSFORGE_GUARD_REQUIRE_BRIEF=0`) skips the nudge and goes
straight to the page; if no brief was given, the page flags that clearly.

## Flow

```
insforge --reason "<why>" <cmd>  →  parse  →  [preAction: guardHook]  →  action
                                                     │
                          assess() classifies the real operation (hard rules)
                                                     │
              safe? → run.   dangerous? → approval page (rule facts + agent's --reason) → BLOCK
                                                     │
                              approve → run   ·   deny / timeout → exit 1
```

## Files

- `risk-registry.ts` — declarative risk descriptors per command path, **plus**
  SQL inspection for `db query` (DROP / TRUNCATE / unfiltered DELETE-UPDATE /
  ALTER…DROP / RLS changes). Classifies the *real operation params*, not the raw
  argv. A destructive-verb catch-all covers unregistered `*-delete` commands.
- `inspect.ts` — read-only **live introspection** of the linked project so the
  facts are about the *actual* target: real row count, size, and the real
  dependents (incoming foreign keys / dependent views / RLS policies) that will
  break. Measured by InsForge via the same `runRawSql` path `db query` uses (the
  agent can't fake it). **Fail-open** with a 5s timeout: any error → generic rule
  text, and it never changes the verdict.
- `brief.ts` — combines authoritative rule facts (tailored live when available)
  with the agent's structured brief (`--reason` / `--impact` / `--recommendation`).
  No LLM call.
- `approval-server.ts` — single-use localhost HTTP server + browser open; serves
  the card in two groups (rule facts + InsForge guidance · the agent's intent /
  implications / recommendation) and blocks until a click. **Fail-closed**: any
  error or 120s timeout → denied.
- `audit.ts` — append-only `~/.insforge/guard-audit.jsonl` of every decision.
- `index.ts` — the `guardHook` orchestrator (assess → nudge-if-no-brief → page),
  wired in `src/index.ts`.

## Guarantees

- **Fail-closed** — if the page can't open/respond, the command is **denied**.
- **Safe ops never interrupted** — `SELECT`, `insert`, `list`, etc. pass through.
- **Agent can't self-certify** — the stop/allow verdict is the CLI's hard rules,
  never the agent's word.
- **Audited** — every dangerous evaluation is logged with decision + timestamp.

## How an agent passes its brief

Instruct agents (via the InsForge skill / MCP) to attach a brief to destructive
commands. The flags map directly to the page sections:

```bash
insforge \
  --reason         "Dropping deprecated users table; app moved to accounts last week" \
  --impact         "14,200 rows destroyed; sessions.user_id FK breaks; irreversible without nightly backup" \
  --recommendation "Approve only if the accounts cutover is confirmed and tonight's backup exists" \
  db query "DROP TABLE users"
```

`--reason` is the one that satisfies the nudge; `--impact` and `--recommendation`
are optional enrichments. Each has an env fallback.

## Env knobs

| Var | Effect |
|-----|--------|
| `INSFORGE_GUARD_SUMMARY` | Agent intent (env fallback for `--reason`). |
| `INSFORGE_GUARD_IMPACT` | Agent implications (env fallback for `--impact`). |
| `INSFORGE_GUARD_RECOMMENDATION` | Agent recommendation (env fallback for `--recommendation`). |
| `INSFORGE_GUARD_REQUIRE_BRIEF` | `1` = always require a brief; `0` = never (go straight to page). Default: require for non-interactive callers. |
| `INSFORGE_GUARD_BYPASS=1` | Skip approval (audited as `bypassed`) — for opted-in automation. |
| `INSFORGE_GUARD_OPEN=0` | Print the approval link only; don't auto-open a browser (headless). |
| `INSFORGE_GUARD_TIMEOUT_MS` | Approval window in ms before fail-closed deny (default 120000). |

## Exit codes (when blocked)

| Code | Meaning |
|------|---------|
| `0` | Approved (or safe — never interrupted). |
| `1` | Denied / timed out by the human. |
| `2` | `needs_brief` — non-interactive caller gave no brief; re-run with `--reason …`. |

## Try it

```bash
npm run build
# non-interactive + no brief -> prints the nudge, exits 2 (command not run):
node dist/index.js db query "DROP TABLE users"
# with a brief -> stops for approval, prints a localhost link:
node dist/index.js --reason "why" --impact "what's affected" --recommendation "rec" \
  db query "DROP TABLE users"
# safe -> runs without interruption:
node dist/index.js db query "SELECT 1"
```
