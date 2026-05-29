# Human-in-the-loop guard (POC)

Stops dangerous InsForge CLI operations for human approval **before** they run.
Because it lives inside the `insforge` binary as a Commander `preAction` stage —
not in any agent's harness — it protects **every** caller automatically: Claude
Code, Cursor, shell scripts, CI, and humans. The agent's process blocks on a
localhost approval page until a human clicks Approve or Deny.

## Flow

```
insforge <cmd>  →  parse  →  resolve command  →  [preAction: guardHook]  →  action
                                                       │
                            assess() classifies the real operation
                                                       │
                          safe? → run.   dangerous? → buildBrief() → approval page (BLOCK)
                                                       │
                              approve → run   ·   deny / timeout → exit 1
```

## Files

- `risk-registry.ts` — declarative risk descriptors per command path, **plus**
  SQL inspection for `db query` (DROP / TRUNCATE / unfiltered DELETE-UPDATE /
  ALTER…DROP / RLS changes). Classifies the *real operation params*, not the raw
  argv. A destructive-verb catch-all covers unregistered `*-delete` commands.
- `brief.ts` — builds the human-readable card. Tries local `claude -p` for a
  context-aware explanation (no API key needed); deterministic fallback if the
  LLM is missing/slow. Never blocks on the LLM (12s timeout).
- `approval-server.ts` — single-use localhost HTTP server + browser open; serves
  the card (what happens · blast radius · risks · intent · recommendation) and
  blocks until a click. **Fail-closed**: any error or 120s timeout → denied.
- `audit.ts` — append-only `~/.insforge/guard-audit.jsonl` of every decision.
- `index.ts` — the `guardHook` orchestrator, wired in `src/index.ts`.

## Guarantees

- **Fail-closed** — if the brief can't render or the page can't open/respond, the
  command is **denied**, never silently run.
- **Safe ops never interrupted** — `SELECT`, `insert`, `list`, etc. pass straight through.
- **Audited** — every dangerous evaluation is logged with decision + timestamp.

## Env knobs

| Var | Effect |
|-----|--------|
| `INSFORGE_GUARD_BYPASS=1` | Skip approval (audited as `bypassed`) — for opted-in automation. |
| `INSFORGE_GUARD_NO_LLM=1` | Force the deterministic brief, skip `claude -p`. |
| `INSFORGE_GUARD_OPEN=0` | Print the approval link only; don't auto-open a browser (headless). |

## Try it

```bash
npm run build
# stops for approval, prints a localhost link:
node dist/index.js db query "DROP TABLE users"
# safe — runs without interruption:
node dist/index.js db query "SELECT 1"
```
