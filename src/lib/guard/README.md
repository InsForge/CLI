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
  the most context about *why* it's running the command. It passes its summary +
  implications via `--reason "..."`. The CLI makes **no LLM call of its own** — so
  there are no keys to configure and it works for any agent. The agent can
  explain, but it **cannot change the verdict**.

If the agent supplies no `--reason`, the page falls back to the deterministic
rule text and flags that no rationale was given.

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
- `brief.ts` — combines authoritative rule facts with the agent's `--reason`
  explanation. No LLM call.
- `approval-server.ts` — single-use localhost HTTP server + browser open; serves
  the card (rule facts · agent explanation · recommendation) and blocks until a
  click. **Fail-closed**: any error or 120s timeout → denied.
- `audit.ts` — append-only `~/.insforge/guard-audit.jsonl` of every decision.
- `index.ts` — the `guardHook` orchestrator, wired in `src/index.ts`.

## Guarantees

- **Fail-closed** — if the page can't open/respond, the command is **denied**.
- **Safe ops never interrupted** — `SELECT`, `insert`, `list`, etc. pass through.
- **Agent can't self-certify** — the stop/allow verdict is the CLI's hard rules,
  never the agent's word.
- **Audited** — every dangerous evaluation is logged with decision + timestamp.

## How an agent passes its explanation

Instruct agents (via the InsForge skill / MCP) to attach a rationale to
destructive commands:

```bash
insforge --reason "Dropping deprecated users table; 14k rows lost; app moves to accounts; backup confirmed" \
  db query "DROP TABLE users"
```

Or via env: `INSFORGE_GUARD_SUMMARY="..."`.

## Env knobs

| Var | Effect |
|-----|--------|
| `INSFORGE_GUARD_SUMMARY` | Agent explanation (alternative to `--reason`). |
| `INSFORGE_GUARD_BYPASS=1` | Skip approval (audited as `bypassed`) — for opted-in automation. |
| `INSFORGE_GUARD_OPEN=0` | Print the approval link only; don't auto-open a browser (headless). |

## Try it

```bash
npm run build
# stops for approval, prints a localhost link:
node dist/index.js --reason "why I'm doing this" db query "DROP TABLE users"
# safe — runs without interruption:
node dist/index.js db query "SELECT 1"
```
