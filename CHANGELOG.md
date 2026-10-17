# Changelog

## 1.0.0 (2026-10-18)

First public release. Version 1.0.0 bundles the seventh generation of an
extension that was developed measurement-first: every feature below was added
in response to a observed failure mode in benchmark runs, and the full
v1 → v7 progression is documented in [docs/BENCHMARK.md](docs/BENCHMARK.md).

- **File-backed todos** — one Markdown file per todo in `.pi/todos/`, with
  JSON front matter (status, tags, timestamps, assignment). State survives
  process crashes, session restarts, and context compaction; it is readable
  and editable by humans and other tools.
- **Todo tool** (`todos`) — create / update / list / get / append / close /
  claim / release with a compact one-line result format (~230 tokens of tool
  text per request; 23% leaner than the pre-lean generations).
- **Lean-by-design prompt surface** — salient description, `promptSnippet`
  and a "3+ steps" trigger guideline; measured 3/3 voluntary model adoption
  with zero false positives on single-step tasks (short and compacted).
- **Compaction re-injection** — on `session_compact`, open todos are
  re-injected into context as a one-line reminder; silent when the list is
  empty or fully closed.
- **Session assignment** — todos claimed by a session are skipped by other
  sessions (multi-agent safe); `claim`/`release` manage ownership.
- **Pid-based locking with steal semantics** — concurrent writers hold a
  lock file; locks held by dead processes are stolen automatically, live but
  stale locks can be stolen interactively (never silently in headless mode).
- **Garbage collection** — todos closed more than 30 days ago (by
  `closed_at`, falling back to `created_at` for legacy files) are deleted on
  session start.
- **Auto-promotion (v7)** — when a todo is closed and no open todo is
  `in_progress`, the earliest open todo is promoted automatically under lock;
  parallel closes in one turn are single-flighted so exactly one promotion
  fires per batch. Measured: +52% relative ever-in-progress coverage, zero
  prompt-text cost, best-in-field judge `todoUsage` score.
- **`/todos` command** — interactive TUI browser (filtered views, status
  changes) for interactive sessions.
