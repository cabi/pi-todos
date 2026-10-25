# Glossary

Domain and architecture terms for `pi-todos`, in the order you meet them in
`todos.ts`. Keep this current when concepts change or new ones get names.

## Todo store

The directory of durable Markdown todo files (default `todos/` in the
workspace, overridable via `PI_TODO_PATH`). Each file is one todo named by its
id (`TODO-<8 hex>.md`). The store is the single source of truth: every action
reads and writes it through the same front matter format, sessions share it,
and a fresh session reconstructs all state from it. Garbage collection
(ancient closed todos) runs once per session at `session_start`.

## Front matter

The JSON header at the top of every todo file (2-space indent, `---` fences),
holding all metadata: `id`, `title`, `status`, `tags`, `body`, timestamps
(`created_at`/`updated_at`/`closed_at`), and `assigned_to_session`. Followed by
the Markdown body. Parsed/serialized by `parseTodoContent`/`serializeTodo`;
anything reading or writing a todo file goes through this format — there is no
second representation on disk.

## Status

The canonical status set is the closed union `open | in_progress | closed`
(`TodoStatus`), and `isTodoClosed(status)` is the single answer to "is this
todo closed?" — it is a type-checked question, not a convention. Older files
spell closed as `completed`, `done`, `complete`, `finished` or `cancelled`,
and open as `pending`/`new`/`created`; `toTodoStatus` canonicalizes all of them
at the read edge (`parseFrontMatter`), so list ordering, promotion, claiming
and garbage collection all see the same answer. The next write persists the
canonical spelling; an unrecognized spelling reads as `open`. Agent input runs
through the same `STATUS_ALIASES` table in `prepareTodoArguments`, before
schema validation. Why it works this way: ADR-0001.

## Living error

An id error that teaches recovery instead of just failing: it carries a
diagnosis (bad length vs. bad characters), up to three near-miss suggestions
(`Did you mean:`), or — when nothing is close — the open roster (top 5) or a
hint that only closed todos remain. Living errors are never auto-applied; the
caller must re-run with an exact id. Built by `buildTodoIdError`, rendered for
the tool channel by `renderTodoToolError` (`TodoError` values carry no prose).

## Assignment

The `assigned_to_session` front matter field claiming a todo for one session.
Claiming a todo assigned to another session requires `force`; closing a todo
clears its assignment (`clearAssignmentIfClosed`). Released by setting the
field to `undefined` (absent in JSON).

## Promotion

v7 auto-promotion: when a todo closes and no open todo is `in_progress`, the
first open todo in list display order (skipping todos assigned to other
sessions) is promoted to `in_progress`, so the list always points at current
work. Single-flight (`closeFlights`): when several closes finish in parallel,
only the last one may promote. Fills vacancies only — never demotes parallel
`in_progress` items. Reported via the `Promoted TODO-… → in_progress: …` note.

## Action gate

The resolve → mutate → answer pipeline every tool action passes through
(`resolveTodoId` → `mutateTodo` → `toolAnswer` / `toolErrorResult`):

- **Resolve** (`resolveTodoId`): the id is present, well-formed, and points at
  an existing file; failures are `TodoError` values (`id_required`,
  `invalid_id`, `not_found`).
- **Mutate** (`mutateTodo`): fn sets domain fields on the record in place; the
  gate owns the mutation protocol — lock, id/created_at stamping,
  assignment-clearing on close, `updated_at` touch, write, lock release. fn
  returns `NO_WRITE` for idempotent no-ops or a `TodoError` to abort without
  writing. Single-flight promotion policy hangs off this gate
  (`closeWithPromotion`).
- **Answer** (`toolAnswer` / `toolErrorResult`): assemble the
  `{content, details}` tool result; errors travel as values in `details.error`
  and are rendered per channel (living error text for the agent, one short
  line for the TUI).

Cases in `execute()` carry action logic only — no resolution, locking, or
protocol ceremony.
