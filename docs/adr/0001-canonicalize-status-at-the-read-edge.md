# Canonicalize `status` at the read edge

**Status:** accepted (2026-10-25)

A todo file's `status` is canonicalized exactly once, when the file is read:
`parseFrontMatter` maps any spelling (`completed`, `done`, `complete`,
`finished`, `cancelled`, `pending`, `new`, `created`, `active`, `wip`,
`in-progress`, `working`) onto the closed union `open | in_progress | closed`
via `toTodoStatus`, and stores it in the typed `TodoFrontMatter.status` field
(`TodoStatus`). Every consumer downstream — list ordering, TUI counters,
v7 promotion, claim refusal, garbage collection — reads the field directly;
`isTodoClosed(status)` is a plain equality and knows nothing about aliases.
The next write persists the canonical spelling, so legacy files heal
themselves one at a time.

## Considered Options

- **Canonicalize at each decision site** (the previous arrangement): a
  `getTodoStatus(todo)` helper called by the paths that needed it, while others
  called the raw `isTodoClosed`. Rejected because it is exactly what broke:
  presentation canonicalized, decisions did not, and `TodoFrontMatter.status`
  stayed `string`, so nothing — human or compiler — noticed the divergence. It
  also meant every new decision had to remember to opt in.
- **Preserve unknown spellings verbatim**: rejected because it keeps `status`
  a `string`, which is the root cause. A file with `"status": "blocked"` reads
  as `open` and is rewritten as such on its next mutation. That silent
  one-time rewrite is accepted deliberately: the alternative is a typed field
  that lies about its contents.

## Consequences

- `status` is canonical in memory at all times, so "is this closed?" is a
  type-checked question. Adding a raw alias anywhere is a compile error, not a
  convention to remember.
- Legacy closed todos become garbage-collectible. With no `closed_at` they age
  from `created_at` (the existing fallback), so the first `session_start` after
  upgrading can delete old completed todos that were previously immortal. This
  is intended: they are closed, and collecting ancient closed todos is what GC
  is for.
- Agent input passes through the same `STATUS_ALIASES` table in
  `prepareTodoArguments`, but *without* the unknown→open fallback: an
  unrecognized status still reaches schema validation so the caller gets a
  useful error instead of a silent coercion. One table, two edges, two
  fallback behaviours.
