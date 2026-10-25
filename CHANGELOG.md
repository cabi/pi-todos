# Changelog
## 1.2.1 (2026-10-25)

- **One closed-knower** — `status` is now the closed union
  `open | in_progress | closed` and `isTodoClosed` is a plain equality, so the
  question "is this todo closed?" is type-checked instead of conventional. One
  `STATUS_ALIASES` table serves both edges: `toTodoStatus` canonicalizes
  everything read off disk inside `parseFrontMatter` (list, parse, garbage
  collection), and the same table normalizes agent input before schema
  validation. `getTodoStatus` and its duplicate alias table are gone; the 15
  raw `isTodoClosed` call sites were corrected by typing the field, without
  being touched.
- **Behaviour change, deliberate**: todos whose files spell closed as
  `completed`, `finished`, `cancelled`, `complete`, `done` (and open as
  `pending`/`new`/`created`) are now genuinely closed everywhere. Previously
  they rendered as `[closed]` yet sorted as open, were auto-promoted to
  `in_progress` by v7, accepted claims, and could never be garbage collected.
- **Migration notes** — unrecognized status spellings read as `open` and are
  rewritten in canonical form on the next mutation (one-time on-disk heal).
  Legacy closed todos become garbage-collectible, aged from `created_at` when
  `closed_at` is absent, so the first `session_start` after upgrading may
  remove old completed todos that were previously immortal.
- Tests: new `#11 legacy statuses` section (9 checks) covering listing,
  claim refusal, promotion skip, write-back canonicalization, the unknown-status
  heal, and GC of a legacy closed todo; 77 tests total.

## 1.2.0 (2026-10-25)

- **Action gate** — the `todo` tool's nine cases now flow through a deep
  action gate instead of per-case ceremony: `resolveTodoId` (id present,
  well-formed, file exists), `mutateTodo` (lock, stamp, write — the mutation
  protocol can no longer be done wrong by a caller), and `toolAnswer`
  (uniform success results). `buildTodoIdError` call sites drop from 16 to 3;
  the file shrinks by ~90 lines while gaining the structure.
- **Errors as values** — a `TodoError` value (`kind` + payload, no prose)
  flows from every failure site; two renderers own all wording: the agent
  tool channel keeps the byte-identical living-error text, the TUI renders
  one short line. Fixes a shipped bug where the TUI showed `Error: Error: …`
  twice, and a latent one where TUI error notifications were dead code
  (`"error" in` never matched) — release/delete/close failures now surface.
- **Strict typecheck against pi 1.4.0** — `npm run typecheck` compiles
  `todos.ts` with `--strict --noEmit` against the installed pi release; it is
  chained into `npm test`, and the test harness resolves the newest installed
  release instead of pinning one. pi 1.4.0's `KeybindingsManager` is adapted
  to the components' matcher shape at the boundary.
- **GLOSSARY.md** — settles the domain and architecture vocabulary (todo
  store, front matter, living error, promotion, assignment, action gate).
- Dead code dropped: `listTodosSync`, `displayId`, no-op `invalidate`
  overrides.

## 1.1.0 (2026-10-19)

- **Living id errors** — every invalid or unknown todo id now returns a
  self-recovering error instead of a bare `Invalid todo id. Expected
  TODO-<hex>.`: the diagnosis says *why* the id failed (length or bad
  characters), a "Did you mean" section suggests near-miss todos (edit
  distance ≤ 2 — catches dropped, mistyped, or transposed characters) with
  id, status, and title inline, and a roster of open todos plus the
  `todo list` / `todo list-all` recovery hint is always appended when no
  near match exists. Suggestions are never applied automatically; mutations
  still require the model to re-run with the exact id.

## 1.0.0 (2026-10-18)

Derived from the `todos` extension by Armin Ronacher
([mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)), Apache-2.0 —
see [NOTICE.md](NOTICE.md) for the change list relative to upstream.

First public release. Version 1.0.0 bundles the seventh generation of an
extension that was developed measurement-first: every feature below was added
in response to a observed failure mode in benchmark runs, and the full
v1 → v7 progression is documented in [docs/BENCHMARK.md](docs/BENCHMARK.md).

- **File-backed todos** — one Markdown file per todo in `.pi/todos/`, with
  JSON header (id, title, tags, status, timestamps, assignment). State survives
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
