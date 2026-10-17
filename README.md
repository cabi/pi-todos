# pi-todos

*A file-backed todo tool for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — durable Markdown todo files with pid-locking, garbage collection, compaction re-injection, and single-flight auto-promotion.*

**Based on the [`todos`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/todos.ts) extension by [Armin Ronacher](https://github.com/mitsuhiko) ([agent-stuff](https://github.com/mitsuhiko/agent-stuff)), Apache-2.0 — extensively extended and benchmarked (see [Credits](#credits--license)).**

Most todo extensions keep task state in the model's context (replayed from the session log). pi-todos instead writes **one Markdown file per todo** into `.pi/todos/`. The state survives crashes, session restarts, context compaction, and handovers between sessions — and it is plain files you can read, grep, and edit yourself.

```
```jsonc
// .pi/todos/TODO-523169a1.md — one file per todo: JSON header + free Markdown body
{
  "id": "523169a1",
  "title": "Fix token refresh in the API layer",
  "tags": ["api", "auth"],
  "status": "in_progress",
  "created_at": "2026-10-18T09:12:44.001Z",
  "updated_at": "2026-10-18T09:14:02.310Z",
  "assigned_to_session": "4f1c9a2e"
}
The refresh endpoint 500s when the grant expired more than 24h ago …
```

## Why this one

| property | pi-todos | session-replay extensions |
|---|---|---|
| State survives crash / restart / new session | ✅ files on disk | in-memory per session |
| Survives context compaction | ✅ re-injection hook + files | replay from session log |
| Multi-agent safe (two sessions, one repo) | ✅ claim/release + assignment | — |
| Concurrent-write safety | ✅ pid locks w/ dead-lock stealing | — |
| Self-cleaning | ✅ GC of closed > 30 days | — |
| Keeps statuses current without model effort | ✅ auto-promotion on close | — |
| Token cost per request | **lowest measured** (25–50% under npm field) | — |

Benchmarked against four npm todo extensions across 90+ real agent sessions — see [Benchmark](#benchmark) below.

## Install

Requires pi ≥ 1.3 and Node ≥ 18.

```bash
pi install git:github.com/cabi/pi-todos
```

Project-local instead of global:

```bash
cd your-project
pi install -l git:github.com/cabi/pi-todos
```

Or pin a release:

```bash
pi install git:github.com/cabi/pi-todos#v1.0.0
```

Try it once without installing:

```bash
pi -e git:github.com/cabi/pi-todos -p "plan and do a three-step task"
```

Update / remove:

```bash
pi update pi-todos
pi remove git:github.com/cabi/pi-todos
```

After installing, just work normally. When a task has 3+ steps the model reaches for the `todos` tool on its own (measured 3/3 voluntary adoption, zero false positives on single-step tasks). Manage lists yourself any time with the `/todos` command.

## The tool

One tool, `todos`, with a compact action surface (IDs are stable `TODO-xxxxxxxx`):

| action | example |
|---|---|
| `create` | `{ "action": "create", "title": "Fix token refresh", "description": "…", "tags": ["api"] }` |
| `list` | `{ "action": "list" }` — one line per todo |
| `get` | `{ "action": "get", "id": "TODO-523169a1" }` — full file |
| `update` | `{ "action": "update", "id": "TODO-…", "status": "closed" }` — also title/description/tags |
| `append` | `{ "action": "append", "id": "TODO-…", "body": "found second bug: …" }` |
| `claim` / `release` | `{ "action": "claim", "id": "TODO-…", "session": true }` — multi-session ownership |
| `close` | shorthand for `update → closed` |

Statuses: `open` → `in_progress` → `closed` (legacy aliases are normalized on read).

**Auto-promotion.** When a todo is closed and no open todo is `in_progress`, the next open todo is promoted automatically (under lock, skipping todos owned by other sessions): the tool result says `Promoted TODO-x → in_progress: <title>`. Parallel closes in one turn fire exactly one promotion — no races, no noise.

**Compaction re-injection.** On `session_compact` the extension sends a one-line open-todos reminder, so long tasks never "forget" the list. Silent when nothing is open.

## Storage & safety

- `.pi/todos/*.md` — one file per todo: JSON header (id, title, tags, status, timestamps, assignment) + free Markdown body.
- `.pi/todos/.lock` — write lock; held by a dead pid is stolen automatically, held by a live stale process only interactively (headless runs refuse, never corrupt).
- On session start, todos closed > 30 days are garbage-collected (`closed_at`, falling back to `created_at`).
- Files are plain Markdown: `git add .pi/todos` if you want todo history in the repo.

## Tests

52 unit tests (mock-pi harness driving the real `execute()`, including parallel-close races and lock stealing):

```bash
npm test        # or: node test/todos.test.mjs
```

## Benchmark

Compared against `@juicesharp/rpiv-todo` (+ its lean wrapper), `@inobit/pi-todo`, and `@gamaraan/todos-tool`: 6 scenarios × 15 runs per contender, real headless pi sessions (glm-5.3), cross-family LLM judge, ground-truth call counting from session JSONL. Full methodology, per-scenario data, and the v1 → v7 development ladder: [docs/BENCHMARK.md](docs/BENCHMARK.md).

| extension | session judge /10 | todoUsage | io tokens/run | s2 adoption | false-positives | content /8 | hygiene | durable storage |
|---|---|---|---|---|---|---|---|---|
| rpiv-todo | 8.40 | 7.20 | 26.1k | 2/3 | 1/5 | 7.20 | 2.0 | — |
| rpiv-todo-lean | 8.40 | 7.13 | 22.4k | 3/3 | 0/5 | 7.40 | 2.0 | — |
| **pi-todos (v7)** | 8.33 | **7.27** | **13.2–15.4k** | **3/3** | 0/5 | 7.19 | **2.0** | ✅ |
| inobit-pi-todo | 8.20 | 6.60 | 21.7k | 1/3 | 1/5 | 6.45 | 1.11 | — |
| gamaraan-todos-tool | 8.13 | 6.67 | 18.7k | 3/3 | 0/5 | 6.60 | 1.3 | — |

*(same judge, all axes; judge spread 0.27 = noise — the field does not separate on session quality.)*

Findings:

- **Cheapest in the field** — 25–50% less session io than every npm contender, at equal or better task scores (0.943–0.975 vs 0.950–0.972, noise range).
- **Best todoUsage** of all seven judged (7.27): statuses stay current — auto-promotion at work.
- **Zero false positives** on single-step tasks, short or compacted; aggressive adopters in the field slipped (rpiv-todo and inobit 1/5).
- **Compaction-proof**: state is on disk; the re-injection hook keeps it in context. Long-task scores 0.91–1.0 with 1–6 compactions per run.
- Every feature above was added in response to a measured failure: adoption 0/3 → prompt surface work; post-compaction lapse → re-injection; hygiene gap (ever-in-progress 0.16 vs 0.75) → auto-promotion (+52% relative, at zero prompt cost).

## Compatibility

- pi ≥ 1.3 (extension API: `registerTool`, `registerCommand`, `session_start` / `session_compact` hooks)
- Node ≥ 18, no runtime dependencies
- Works headless (`-a`) and interactive (TUI `/todos` browser)

## Credits & License

This extension is a derivative of the **`todos` extension by Armin Ronacher**
([`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff), published
there as part of the `mitsupi` package). The core design — one Markdown file
per todo under `.pi/todos/`, the `/todos` TUI, and the original tool surface —
is his; the bulk of the code originates there.

Distributed under the **[Apache License 2.0](LICENSE)** (upstream's license).
Changes in this fork, developed measurement-first across seven generations
([docs/BENCHMARK.md](docs/BENCHMARK.md)):

- lean prompt surface: salient description, `promptSnippet`, "3+ steps" trigger guideline, compact list serialization, slim mutation echo, enforced status enum (~230 tokens of tool text per request, −23%)
- `session_compact` re-injection of open todos (no more post-compaction forgetting)
- session `claim`/`release` assignment for multi-agent work
- pid-based write locking with dead-lock stealing (headless-safe)
- garbage collection of todos closed > 30 days (`created_at`/`updated_at`/`closed_at` timestamps)
- single-flight auto-promotion: closing a todo promotes the next open one to `in_progress`

Modifications © 2026 cabi. See [NOTICE.md](NOTICE.md).
