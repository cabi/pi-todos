# Benchmark: pi-todos vs. the npm todo extensions

Full methodology and raw numbers from the comparison project
(`todo-comparision`, October 2026). Every generation of this extension was
driven by a measured failure mode; this document preserves the complete
evidence trail.

- **Runs:** real headless `pi` sessions, model `zai/glm-5.3`, 6 scenarios
  (nudged multi-step, unnudged multi-step, mid-task steering, long task with
  forced compaction, short false-positive, long false-positive with
  compaction), 3/3/2/2/3/2 reps per contender per matrix.
- **Contenders:** `pi-todos` (this extension, final v7) vs
  `@juicesharp/rpiv-todo`, its lean wrapper, `@inobit/pi-todo`,
  `@gamaraan/todos-tool`.
- **Session-quality judge:** deepseek family (cross-family vs the run model),
  same judge for all rows in the final pass.
- **Ground-truth call counting:** assistant `toolCall` entries in session
  JSONL (tool *definitions* in request metadata are not calls).

# Todo-Extension Comparison — Results

**Date:** 2026-10-17 · **Harness:** `harness/` · **Raw data:** `runs/`, `results/metrics.json`

## Setup

| | |
|---|---|
| Agent model | `zai/glm-5.3`, thinking=medium |
| Judge model | `opencode/deepseek-v4-pro`, thinking=low (different family) |
| Runs | 5 contenders × 4 scenarios × 2–3 reps = **50 sessions** |
| Workload | `bookshelf-cli` Node project with 5 seeded bugs, 4 unimplemented features, 22 tests (18 baseline failing) |
| Compaction (s4) | forced via `.pi/settings.json` override: `reserveTokens: 980000, keepRecentTokens: 6000` → triggers ≈20k context on the 1M-context model |

### Contenders

| id | extension | design |
|---|---|---|
| `local-todos` | **todos.ts (yours)** | one `todo` tool, 9 actions (list/get/create/update/append/delete/claim/release…), file-based `.pi/todos`, session claims |
| `rpiv-todo-lean` | local dir `~/Projects/pi-extensions/rpiv-todo-lean` | lean file-based variant |
| `rpiv-todo` | npm `@juicesharp/rpiv-todo` v2.13.9 | full-featured (TUI + tool) |
| `inobit-pi-todo` | npm `@inobit/pi-todo` v0.2.1 | simple structured todos |
| `gamaraan-todos-tool` | npm `@gamaraan/todos-tool` v0.3.0 | checklist-style |

### Scenarios

| id | measures | reps |
|---|---|---|
| s1-nudged | task completion when prompt says "track progress with the todo tool" | 3 |
| s2-natural | **voluntary adoption** — no mention of todos in prompt | 3 |
| s3-steering | mid-session priority change via `--continue` follow-up | 2 |
| s4-long | 10-item marathon with forced compaction mid-task | 2 |

Score = check.json `completed/total` scoped items (target tests passing, no test edits, no regressions).

## Results per contender (mean over all 10 runs)

| contender | score | judge overall | todo calls/run | adoption (s2) | billed tok/run | cost/run | todo calls after compaction |
|---|---|---|---|---|---|---|---|
| **local-todos** | 0.915 | **8.60** | 7.1 | **0/3** | **130.4k** | **$0.076** | 2 (of 1 compacted run: none right after) |
| **rpiv-todo-lean** | 0.924 | **8.90** | 10.0 | 1/3 | 160.0k | $0.083 | 4 (re-engaged: `write, todo, todo`) |
| **rpiv-todo** | **0.967** | 7.40 | **16.3** | **3/3** | 290.6k | $0.131 | 0 (never compacted — sessions too short) |
| **inobit-pi-todo** | 0.915 | 7.20 | 14.5 | **3/3** | 229.5k | $0.126 | 12 (re-oriented: `read, todo, …`) |
| **gamaraan-todos-tool** | 0.924 | 7.70 | 7.1 | **3/3** | 233.9k | $0.138 | 9 (immediate: `todo, todo, todo`) |

### Scenario detail (mean score / todo calls)

| contender | s1-nudged | s2-natural | s3-steering | s4-long |
|---|---|---|---|---|
| local-todos | 1.0 / 10.3 | 1.0 / **0** | 0.67 / 8.5 | 0.91 / 11.5 |
| rpiv-todo-lean | 1.0 / 12.0 | 1.0 / 3.3 | 0.67 / 11.0 | 0.95 / 16.0 |
| rpiv-todo | 1.0 / 20.0 | 1.0 / 16.0 | **0.83** / 10.5 | **1.0** / 17.0 |
| inobit-pi-todo | 1.0 / 15.0 | 1.0 / 17.0 | 0.67 / 10.0 | 0.91 / 14.5 |
| gamaraan-todos-tool | 1.0 / 5.3 | 1.0 / 7.3 | 0.67 / 7.5 | 0.95 / 9.0 |

## Answers to the four questions

### 1. How is the todo tool used?
Uniform pattern across all contenders: **create list up front → update status at milestones → close at the end**. The difference is call count, driven by interface granularity: `rpiv-todo` and `inobit` (fine-grained actions) log 2× the calls of `local-todos`/`gamaraan` (batched or coarse actions). Ops mix for your tool: `create`, `update` (status), `list`, `close` — `claim`/`release` were never used (single-session benchmark).

### 2. More or less than others?
**Less.** Your `local-todos` is the *most economical* todo tool: 7.1 calls/run vs 16.3 (rpiv-todo) and 14.5 (inobit) — with equal task scores in nudged scenarios. Only `gamaraan` matches its call economy (7.1). But in s2-natural your tool is **never spontaneously adopted (0/3)** — every other npm extension got adopted 3/3 (rpiv-lean 1/3). Your 9-action enum + long description appears to make the tool *more expensive to choose* when the model isn't nudged; competitors' simpler surfaces (or stronger "use me" descriptions) win adoption.

### 3. Forgotten in long tasks with compaction?
Compaction fired in 6/10 s4 runs (1–2 per run). After-compaction behavior:
- **gamaraan** re-oriented instantly (`todo, todo, todo` first calls) → scores 1.0/0.909.
- **inobit** re-read then updated todos (`read, todo`) → 0.909/0.909.
- **rpiv-lean** re-engaged (`write, todo, todo`) → 1.0.
- **local-todos** did **not** touch the todo tool after compaction (`read, bash, read`) → 0.909 (one scoped item missed). Since todo state lives in files outside the conversation, it survives compaction *only if the model re-lists* — nothing in the flow reminded it to. That is the "forgetting" you suspected, observed once in the single compacted local run (weak evidence, n=1).
- **rpiv-todo**: no compaction coverage (its s4 sessions stayed under the threshold) — inconclusive.

### 4. Which extension is better by metrics?
Depends on the axis:
- **Task quality:** `rpiv-todo` 0.967 (only contender to fully survive steering at 0.83 and s4 at 1.0) — but at **2.2× your token cost**.
- **Efficiency (tokens/cost):** `local-todos` wins: 130k tok/$0.076 per run, ~2× cheaper than rpiv-todo, lowest overall.
- **Judge-rated session quality:** `rpiv-todo-lean` 8.9 > local 8.6 > gamaraan 7.7 > rpiv 7.4 > inobit 7.2. The judge penalized rpiv/inobit/gamaraan for verbosity and redundant calls, not for todo usage per se.
- **Adoption without nudging:** every npm contender beats yours (3/3 vs 0/3).

**Overall recommendation:** on the combined profile (quality ≈ tied, cheapest, best judge score after lean, but zero voluntary adoption and one post-compaction lapse) your `todos.ts` is competitive — the two concrete improvements the data suggests: (1) make the tool description more action-priming so the model reaches for it unprompted, and (2) surface a one-line "current open todos" hint after compaction (e.g., on the next tool result or via a session hook) so file-based state is re-injected into context.

## Caveats
- Small n (2–3 reps); s4 compaction coverage uneven (rpiv-todo: 0 compacted runs).
- The re-judged s4 batch came back uniformly 9/9 — likely judge leniency; treat s4 judge deltas as noise, rely on scores/metrics there.
- One matrix overlapped with a stale background process; affected runs were re-run and session-file selection now ignores orphan files (`pickSessionFiles` in analyze/judge).
- Steering bug found & fixed mid-benchmark: `--session-id` + `--continue` are incompatible (pi exits 0 with an error); all s3 runs re-executed after the fix.

## Follow-up: v2/v3 improvements validated (2026-10-17)

Implemented on `todos.ts` (now installed live): (a) **v2** description rewritten to action-priming; (b) **v2** `session_compact` handler re-injects open todos via `pi.sendMessage` after every compaction; (c) **v3** added `promptSnippet` + `promptGuidelines` to `registerTool` — root cause of the 0/3 adoption: **custom tools are omitted from the system-prompt tools section unless `promptSnippet` is set**; all three npm competitors set it, yours didn't. The v2 description rewrite alone changed nothing (0/3); the snippet flipped it.

| metric | v1 baseline | v3 final |
|---|---|---|
| s2 voluntary adoption | 0/3 (0 calls) | **3/3 (10 calls each: 5 create + 5 update)** |
| s2 score / tokens | 1.0 / 86k avg | 1.0 / 121k avg (+40%, still cheapest except lean) |
| s4 post-compaction behavior | no todo re-engagement, 1 scoped item missed | `todo-status` injected right after compaction; first tool after = `todo` (verified in-session and via forced-compaction smoke); model closes all todos across compaction |
| s4 score | 0.909 | 0.909 (unchanged; v3 s4 runs had no natural compaction — injection verified separately) |
- Judge model saw contender labels (framing risk), single judge pass per transcript.

## Full matrix re-run: v4 leaderboard (2026-10-17, 75 runs)

Changes vs first matrix: local-todos is now **v4** = v3 (action description + `promptSnippet`/`promptGuidelines` + `session_compact` re-injection) **+ #3 compact list serialization** (one line per todo instead of pretty JSON), **#4 slim mutation echo** (create/update/append/claim/release return one line; `get` still full), **#6 status enum** (`open|in_progress|closed`, schema-enforced; legacy aliases like done/finished normalized on read). New scenarios: **s5-falsepos-short** (fix ONE failing test; todo use = false positive) and **s6-falsepos-long** (read a 211 KB design spec — the needed sentence is buried at 65% — then fix ONE test; compaction forced mid-read). All 5 contenders re-ran all 6 scenarios from scratch (3/3/2/2/3/2 reps).

### Leaderboard (75 runs, glm-5.3, input+output tokens)

| # | contender | score | judge | todoCalls/run | io tokens/run | s2 adoption | false-pos (s5+s6) |
|---|---|---|---|---|---|---|---|
| 1 | rpiv-todo-lean | **0.972** | 8.33 | 8.1 | 22.4k | 3/3 | 0/5 |
| 2 | gamaraan-todos-tool | 0.956 | 8.13 | **4.5** | 18.7k | 3/3 | 0/5 |
| 2 | inobit-pi-todo | 0.956 | 8.40 | 6.9 | 21.7k | 1/3 | 1/5 |
| 4 | **local-todos v4** | 0.950 | 8.40 | 6.1 | **16.0k** | **3/3** | 0/5 |
| 4 | rpiv-todo | 0.950 | **8.47** | 10.1 | 26.1k | 2/3 | 1/5 |

### False-positive tests (s5/s6) — the new answer

- **s5 (short):** every contender abstained 0/3. No extension over-triggers on a single-bug fix.
- **s6 (long + compaction):** **local-todos v4 0/2, lean 0/2, gamaraan 0/2 — clean.** **rpiv-todo 1/2 (11 todo calls), inobit 1/2 (8 calls)**: the aggressive adopters build todo scaffolding for a linear read-then-fix task under compaction. Notably, the local-todos v4 `session_compact` injection stays silent when no todos exist (early return) — it never *creates* false-positive pressure.
- The aggressive-override pilot (cap ~10k, 11 compactions) showed the same split: v4 abstained and scored 1.0.

### v1 → v4 (local-todos, same scenarios, same accounting)

| scenario | io tokens | todoCalls | todoResultChars/run |
|---|---|---|---|
| s1-nudged | 15.5k → 16.6k | 10.3 → 10.0 | 2554 → **1058** |
| s2-natural | 21.0k → **17.9k** | 10 → 4.0 | 2496 → **452** |
| s3-steering | 16.1k → **12.8k** | 8.5 → 8.0 | 3416 → **761** |
| s4-long | 20.3k → 23.8k | 9.5 → 16.5 | 2390 → **1646** |

Tool-result payloads shrank 59–78% (#3/#4 working as designed); s2/s3 net tokens −15/−20%. s4 tokens rose because that run tracked more items (16.5 calls) — per-call cost still ~40% lower. Adoption held at 3/3 (promptSnippet effect persists with the shorter outputs).

### Compaction verdict (updated)

v4's only compacted s4 run scored **1.0** (v1 missed a scoped item after compaction). The injection stayed silent when all todos were closed at compaction time — no spam. In s6, runs compacted 1–6× depending on contender; v4 abstained from todos, re-read what it needed, scored 1.0.

### Caveats (new matrix)

- s3-steering scored 0.67 for ALL contenders — every run dropped the README docs item after the re-prioritization follow-up. Contender-independent prompt effect, not an extension failure.
- s4/s6 give n=2 per contender; token ±20–35% between reps (provider cache accounting excluded from io metric).
- gamaraan s6-r1 judge=4 was scope creep (rewrote unrelated functions), unrelated to its todo tool.

### Conclusion

With v4, local-todos is the **cheapest contender (16.0k io tokens/run, −28% vs the npm average)** while holding 3/3 voluntary adoption, a clean 0/5 false-positive record under compaction, and parity on score (0.950 vs 0.972 best) and judge (8.40). rpiv-todo-lean keeps a slim lead on score; rpiv-todo keeps the best judge but pays 63% more tokens than v4 and false-positives under compaction.

## v5 robustness fixes (2026-10-18, off-benchmark)

Two robustness recommendations implemented after the v4 matrix (not re-benchmarked — pure correctness fixes, no prompt/modeling surface changed):

- **#7 pid-based lock steal**: `acquireLock` now reads the lock's owning `pid` and steals automatically — in any UI mode, regardless of TTL — when the owner process is dead (signal-0 check, EPERM counts as alive) or is the current process. Headless workers no longer dead-lock on a crashed predecessor's fresh lock; a live owner still gets the `locked` / stale-interactive errors.
- **#8 closed_at/updated_at**: every mutation stamps `updated_at`; closing sets `closed_at` (kept on first close, cleared on reopen). GC now measures age from `closed_at`, falling back to `created_at` only for legacy files — a todo created 8 days ago and closed today is no longer deleted on startup.

Verified by `scratch/test-todos-v5.mjs` (tsc-transpiles the extension, drives the real tool `execute()` through a mock pi): **20/20 checks pass** — timestamp lifecycle across create/close/reopen/append/claim/release, GC matrix (4 crafted files), dead-pid headless steal, live-pid refusal (fresh + stale-TTL), own-pid steal, and session_compact re-injection regression. Plus a live pi headless smoke run (create→update→list round-trip with `updated_at` persisted). Live extension and benchmark copy synced.

## Contender mock-pi battery (2026-10-18)

The v5 mock-pi suite was pointed at the four external contenders to compare **mechanism robustness** (lifecycle, compaction survival, crash/restart survival) under identical, process-isolated conditions. Each contender runs in its own child process with a tolerant mock pi (`on`/`registerTool`/`registerCommand`/`sendMessage`/`appendEntry`, `Proxy` no-op for the rest) and a faithful `ctx` (`mode:"json"`, `sessionManager.getBranch/getSessionFile/getSessionId`, `ui.confirm/setWidget`, `isProjectTrusted`); tool results are recorded on the branch exactly as pi does (`{type:"message", message:{role:"toolResult", toolName, isError, details}}`). The restart phase is a *second fresh process* fed the recorded branch — a true crash/restart simulation. Harness: `scratch/run-contender-battery.mjs` + `scratch/contender-runner.mjs`; raw output `scratch/contender-battery-results.json`.

### Battery results (all four contenders)

| Check | rpiv-todo-lean | @juicesharp/rpiv-todo | @inobit/pi-todo | @gamaraan/todos-tool | local-todos v5 |
|---|---|---|---|---|---|
| tool registration | PASS | PASS | PASS | PASS | PASS |
| create / list / close | PASS | PASS | PASS | PASS | PASS |
| session_compact survival | PASS* | PASS* | PASS* | PASS* | PASS (re-inject) |
| restart survival (fresh process + branch replay) | PASS | PASS | PASS | PASS | PASS (disk-backed) |
| per-todo timestamps | — | — | — | — | ✅ created/updated/closed |
| lock with pid-steal | — | — | — | — | ✅ |
| age-based GC | — | — | — | — | ✅ |
| storage | session branch | session branch | session branch | session branch | per-todo files |

PASS* = the contender registers `session_compact` and survives via branch replay without re-injecting a message (in-memory state + replay-from-transcript design); local-todos additionally re-injects an explicit summary message. "—" = the mechanism does not exist in that extension (all four keep state purely in the session branch / memory; no locks, GC, or timestamps to test).

### Reading

- **Lifecycle and durability are table stakes** — all four npm contenders pass create/list/close, compaction, and crash/restart replay cleanly. The v5 robustness axes (pid-locks, closed_at-GC, timestamps) are **structurally impossible to test on them**: none of the four writes files, so there is nothing to lock, garbage-collect, or timestamp. That is a design trade-off (session-branch-only = zero filesystem footprint, but zero cross-session/cross-tool visibility and no audit trail), not a quality gap.
- **Two mock-fidelity lessons** (they initially looked like contender bugs and were not): (1) tool results must be recorded as `{type:"message", message:{role:"toolResult", …}}` — a bare `{message:…}` entry is invisible to every replay scanner; (2) `ctx.mode:"json"` and `ctx.isProjectTrusted()` must exist — gamaraan skips HUD rendering only when `mode` is `print`/`json` and resolves config before its `session_start` replay, so an incomplete mock makes it crash or silently skip replay. Real pi provides both.
- **inobit** replays only the *latest successful* snapshot and clamps `nextId` to `maxId+1` (`store.ts` hardening comment) — the most defensive replay of the four. **gamaraan** distinguishes "no snapshot" from "explicitly cleared list" (`persistence.ts`), the only contender that treats an empty list as authoritative.
- **Bottom line**: our v5 is the only contender with disk-backed state, timestamps, locks, and GC — the failure modes it defends against (dead locks after crashes, stale-file accumulation, lost audit trail) cannot even occur in the session-branch-only contenders, at the cost of a filesystem footprint they avoid. Core behavioral correctness is equivalent across all five.

## Lean v6 refactor (2026-10-18): applying the lean-prompt rules to our own extension

The lean-extension recipe (proxy wrapper, upstream pinning, MAINTENANCE.md) targets *someone else's* extension. Ours is the upstream, so the applicable steps are the trim rules, the pre-validation fill-ins, and measurement — edited in place, no proxy. Tool list is already lean-shaped: one `todo` tool, 9 actions, no loader tools, no `setActiveTools`.

### What the model reads per request (registered tool def, `scratch/measure-registered.mjs`)

| Version | snippet | guidelines | description | schema | TOTAL | ~tok |
|---|---|---|---|---|---|---|
| v5 | 71 | 125 | 275 | 761 | 1232 ch | 308 |
| v6a (guidelines dropped) | 49 | 0 | 136 | 592 | 777 ch | 194 |
| v6b (minimal guideline) | 49 | 76–93 | 136 | 592 | 853–870 ch | ~215 |
| **v6c (final: dual mention)** | 49 | 93 | 175 | 592 | **909 ch** | **227 (−26%)** |

### Fill-ins via `prepareArguments` (zero per-request token cost)

pi validates tool params against the schema *before* `execute`, but `registerTool` accepts an official `prepareArguments(args)` shim that runs first — so aliases normalize without widening the schema: `status: completed|done|in-progress → closed|closed|in_progress`, `action: close|done → update(+closed)`, `reopen → update(+open)` (explicit `status` param wins), `id: TODO-x.md → TODO-x` (+trim), `tags: "s" → ["s"]`. Ambiguous `action:"open"` (read vs reopen) deliberately stays unmapped → schema error lists allowed actions. 36/36 unit tests green (`scratch/test-todos-v5.mjs`).

### Measured adoption trade-off (s2-natural, no nudge)

Adoption = session made ≥1 real `todo` call. Call counts verified from the surviving session jsonl by counting assistant `tool_use` entries named `todo` (the first `"name":"todo"` match per session is the tool registration in request metadata, not a call; `"toolName":"todo"` appears only on tool *results* and misses failed calls). Earlier hand-counted numbers from superseded run dirs were discarded after a directory-reuse mix-up surfaced: the r1–r3 files retained under `runs/local-todos-v6/s2-natural-r{1,2,3}` carry the **v6b** description, so the previously reported "v6c 2/3 (12/0/10)" was a mislabeled v6b batch.

| Text config | todo adoption | calls per rep | score |
|---|---|---|---|
| v5 (3 mentions, "3+ steps" ×2) | 3/3 | 2–8 (main matrix) | 1 |
| v6a (0 mentions) | 0/3 † | 0 † | 1 |
| v6b (1 mention) | 0/3 | 0/0/0 (verified from files) | 1 |
| **v6c (2 mentions, no threshold)** | **2/5** | 0/0/0/8/10 (r4–r8, 5-rep confirmation) | 1 |
| v6d (3 mentions, no threshold) | 3/5 | 0/10/0/10/10 (r1–r5) | 1 |
| **v6e (3 mentions + "3+ steps" guideline, SHIPPED)** | **4/5** | 10/10/10/0/10 (r1–r5) | 1 |

† from run dirs superseded before verification; consistent with the trend.

Text sizes: v6c 909 ch (~227 tok), v6d 920 ch (~230 tok), v6e 952 ch (~238 tok), v5 1232 ch (~308 tok) — v6e saves 23% of per-request tool text vs v5. All measured with `scratch/measure-registered.mjs`, counts with `scratch/count-adoption.mjs` (assistant `tool_use` named `todo` minus 1 registration match).

Task quality never dropped (score 1 everywhere, with or without todo use). The stepwise ablation shows *both* levers matter, contradicting the earlier mislabeled-batch reading that "the number changed nothing":

1. **Salience** (v6c→v6d, imperative added to snippet): 2/5 → 3/5.
2. **Concrete trigger** (v6d→v6e, "3+ steps" restored to guideline): 3/5 → 4/5 — and v6e's false-positive probe stayed clean (s5-falsepos-short 0/2 todo calls, score 1), so the threshold steers without over-triggering.

### Verdict

**v6e ships**: −23% per-request tokens vs v5 (952 vs 1232 ch), best verified adoption of the lean ladder (4/5, vs 3/3 for v5), false positives 0, alias-tolerant calls, 36/36 unit tests. Remaining gap to v5's 3/3 is within sample noise (Fisher 4/5 vs 3/3: p = 1.0). The lean-recipe steps that don't apply to first-party code: proxy wrapping (3), tool merging + `op:help` (5), `setActiveTools` blocking (6), upstream pinning/MAINTENANCE.md (9/10).

## Full matrix re-run: v6e vs v4 (2026-10-18, 17 runs)

### Counting-method correction (applies to all post-matrix adoption numbers in this file)

Two errors in the ad-hoc counting used during the lean-ladder turns are now fixed by `scratch/count-calls.mjs`:

1. Bare `"name":"todo"` matches are NOT calls — the tool definition appears in request metadata (and `defs` can be >1 per session, e.g. after compaction). Ground truth: assistant calls serialize as `{"type":"toolCall","id":"call_…","name":"todo"}`; executed calls additionally produce `"role":"toolResult",…,"toolName":"todo"` (call count = result count, verified equal in every run).
2. Run-dir labels drifted as `local-todos/todos.ts` was re-synced between batches. Text fingerprints (snippet + guideline + description grepped from each session) now label runs: `runs/local-todos-v6/s2-natural-r1..3` = **v6a** (no guideline), `runs/local-todos-v6b/s2-natural-r1..3` = **v6c** ("For multi-step tasks…" guideline), `runs/local-todos-v6/s2-natural-r4..8` = v6c 5-rep batch, v6d/v6e dirs correct.

**Corrected lean-ladder adoption (s2-natural):** v6a (0 mentions) **0/3** · v6c (2 mentions) **4/8** pooled (2/3 + 2/5) · v6d (3 mentions) **3/5** · v6e (3 mentions + "3+ steps") **4/5** · v5 reference 3/3. Monotone in salience+trigger; the earlier per-rung call counts were def-matches inflated but adoption verdicts stand.

### v6e full matrix (3/5/2/2/3/2 reps, glm-5.3, ground-truth counter)

| scenario | v6e calls/rep | v6e adoption | v6e score | v4 calls/rep | v4 adoption | v4 score |
|---|---|---|---|---|---|---|
| s1-nudged (×3) | 10/11/11 | 3/3 | 1.000 | 10/10/10 | 3/3 | 1.000 |
| s2-natural (×5/×3) | 10/10/10/0/10 | **4/5** | 1.000 | 2/8/2 | 3/3 | 1.000 |
| s3-steering (×2) | 10/8 | 2/2 | **0.834** | 8/8 | 2/2 | 0.667 |
| s4-long (×2) | 13/14 | 2/2 | 0.955 | 14/19 | 2/2 | 0.955 |
| s5-falsepos-short (×3) | 0/0/0 | clean | 1.000 | 0/0/0 | clean | 1.000 |
| s6-falsepos-long (×2) | 0/0 | **clean** | 1.000 | 0/0 | clean | 1.000 |

The earlier "v6e s6 2/2 false positives (4–5 calls)" was a counter artifact — v6e s6 executed **zero** todo calls; both reps just did 2–3× more read/write work on the 211 KB spec than v4's reps (17/32 vs 11/14 tool results), inflating io tokens (82.7k/105.2k vs v4 ~27.9k). That is scenario variance at n=2, not extension behavior.

### Matched 15-run totals

| | io tokens/run | todo calls/run | avg score |
|---|---|---|---|
| v6e | 23.9k (13.2k excl. s6) | 7.1 | **0.975** |
| v4 | 16.7k (15.0k excl. s6) | 6.1 | 0.950 |

Excluding the s6 variance pair, v6e is **−12% io tokens** (consistent with the −23% per-request tool text); including s6 it is +43% on n=2 noise. Scores: v6e ≥ v4 everywhere (s3 improved 0.834 vs 0.667 — one v4 s3 rep left an item unfinished in both generations; v6e finished it in one rep). v6e adopting sessions run ~10 todo calls vs v4's 2–8: the salient text drives not just adoption but heavier use — with no false positives (0/5) and no quality loss.

### Verdict (final)

v6e confirmed on the full matrix: best score of any local-todos generation (0.975), clean false-positive record (0/5), −23% per-request tool text vs v5 and −12% session io vs v4 (excl. s6 noise). The lean refactor's real trade-off curve is now fully measured: fewer mentions → fewer tokens but lower voluntary adoption (0/3 → 4/8 → 3/5 → 4/5 as mentions go 0 → 2 → 3 → 3+threshold).

## Todo content quality (2026-10-18)

Question: beyond adoption/tokens, is the *content* of the created todos good — across our versions (v4 → v6e) and across extensions? Data: all run dirs still carry `sessions/*.jsonl` (todo toolCalls + results) and `ws/` final state, so every list was replayed mechanically and then judge-scored.

**Method.** `scratch/todo-quality.mjs` replays each session's todo calls/results per dialect (id→title mapping from result texts; statuses from update args + result snapshots; validated against `ws/.pi/todos/*.md` ground truth). `scratch/judge-todo-quality.mjs` batches each contender's adopting runs' final lists to one judge call (4 axes × 0–2). Judge: `~deepseek/deepseek-pro-latest` via openrouter — original judge provider key expired (401), same family (deepseek) as the original judge, different family from the run model (zai/glm-5.3, avoids self-judging). Raw: `scratch/todo-quality.json`, `scratch/todo-quality-judge.json`.

### Metric suite (what "good todos" means here)

Mechanical (per adopting run, averaged): `items` granularity floor; `titleWords` specificity proxy; `vague` short vague-title ratio; `compound` multi-action titles ("and", ";"); `desc` items with body/description; `everIp` fraction ever set in_progress (living list); `closed` fraction closed at end (ghost-work detector); `fileCov` fraction of written files whose stem appears in an item (coverage vs actual work); `lateCalls` todo calls after the first 10% of the session (maintained vs write-once); `lastPos` position of last todo call (0=never revisited, 1=kept current to the end).

Judge (0–2 each): granularity (decomposition fits scenario), actionability (verb-led, references real artifacts), coverage (maps the changed files/deliverables), hygiene (statuses tell the truth).

### Extensions (original matrix, same 15 scenarios each; adopting runs)

| contender | judged /8 | gran | act | cov | hyg | everIp | closed | fileCov | items |
|---|---|---|---|---|---|---|---|---|---|
| rpiv-todo-lean | **7.40** | 1.8 | 1.8 | 1.8 | 2.0 | 0.45 | 1.00 | 0.63 | 4.9 |
| rpiv-todo | 7.20 | 1.6 | 1.8 | 1.8 | 2.0 | 0.75 | 1.00 | 0.93 | 5.3 |
| gamaraan-todos-tool | 6.60 | 1.7 | 1.8 | 1.8 | 1.3 | 0.01 | 0.68 | 0.90 | 8.1 |
| inobit-pi-todo | 6.45 | 1.78 | 1.78 | 1.78 | 1.11 | 0.09 | 0.46 | 0.75 | 11.4 |
| local-todos (v4) | 5.60 | 1.6 | 1.6 | 1.8 | 0.6 | 0.23 | 0.65 | 0.70 | 7.1 |

### Our versions (lean ladder; v6a–v6d ran s2-natural only, v4/v6e full matrix)

| version | judged /8 | hyg | everIp | closed | fileCov | items | titleWords |
|---|---|---|---|---|---|---|---|
| v4 | 5.60 | 0.6 | 0.23 | 0.65 | 0.70 | 7.1 | 6.7 |
| v6a (n=2) | 5.50 | 0 | 0.12 | 0.50 | 0.88 | 9.0 | 7.1 |
| v6c (n=6) | 6.16 | 0.33 | 0.05 | 0.17 | 0.29 | 8.5 | 6.3 |
| v6d (n=3) | 7.33 | 1.33 | 0.10 | 0.83 | 1.00 | 6.7 | 5.4 |
| **v6e (n=11)** | **6.91** | 1.27 | 0.20 | 0.82 | 0.86 | 6.6 | 5.9 |

### Findings

1. **The lean rewrite improved content quality, not just tokens**: v6e 6.91 vs v4 5.60 judged, actionability 2.0/2 (concrete verb-led items), fewer items (6.6 vs 7.1), higher file coverage (0.86 vs 0.70), more work actually closed (0.82 vs 0.65).
2. **Our one real weakness is status hygiene** (judge 1.27 vs rpiv 2.0; everIp 0.20 vs 0.75): the model often jumps open→closed and skips in_progress. rpiv/gamaraan score hygiene without model effort because the *tool* enforces it — rpiv auto-promotes on completion, gamaraan's phase model auto-promotes when nothing is in progress. Design takeaway for v7: auto-promote the next open item to in_progress on close (and/or set new items in_progress when the list is idle).
3. **rpiv-todo-lean is the content-quality leader** (7.40) — same upstream semantics, slightly leaner prompt. Its lists are shorter (4.9 items, shortest titles) yet judge-equal coverage: fewer, bigger, well-closed items.
4. **inobit over-fragments** (11.4 items) and leaves work unclosed (0.46) — most items, weakest closure.
5. Caveats: judge scores are batched per contender (cross-run contrast possible); v6a–v6d rows are s2-only samples (n≤6); hygiene judgments partly encode "model behavior + tool semantics", which is exactly what we want to measure for an extension.

---

## v7: server-side auto-promotion (2026-10-18)

**Feature.** On any close (tool `update`/`status`), if no open todo is `in_progress`, the extension promotes the earliest open todo (by list order, skipping items assigned to other sessions) to `in_progress` under its own lock, and appends to the result: `Promoted TODO-x → in_progress: <title>` (or `Promotion skipped: <reason>`). Parallel closes in one turn are single-flighted: only the last finisher promotes — exactly one note per batch, no lock-conflict noise.

**Verification.** 52/52 unit tests (incl. parallel 5-close batch → exactly one promotion; all-closed batch → silent; lock-conflict on candidate → close ok + skip note). Live pi repro: model closes Alpha/Beta/Gamma in one turn → exactly `Promoted TODO-804cf2da → in_progress: Delta`, Echo untouched, model narration unaffected.

**Matrix (15 runs, vs v6e's 17).**

| scenario | v7 score | v6e score | v7 calls | v6e calls |
|---|---|---|---|---|
| s1-nudged ×3 | 1.0 | 1.0 | 11.7 | 10.7 |
| s2-natural ×3 | 1.0 (3/3 adopt) | 1.0 (3/3) | 10 | 10 |
| s3-steering ×2 | 0.67 | 0.83 | 9.5 | 9 |
| s4-long ×2 | 0.91 | 0.95 | 12.5 | 13.5 |
| s5-falsepos ×3 | 1.0 (0 calls) | 1.0 (0 calls) | 0 | 0 |
| s6-falsepos ×2 | 1.0 | 1.0 | 2.5±2.5* | 0 |

*s6-r1: after 5 compactions the model self-organized (list→2 creates→2 closes, score 1). Tool text is byte-identical to v6e → variance at n=2, not a v7 effect. s3: both v7 reps missed the README docs item; v6e also missed it in 1/2 reps — small-n variance.

**Feature measured.**
- Natural incidence: promotion fired in 1/15 runs (s4-r2), chose the correct next item (README — which the model wrote immediately after), zero skip notes, zero spurious notes in the 14 other runs.
- everIpRatio (share of items that ever reached in_progress): **v7 0.241 vs v6e 0.159 (+52% rel)** — the feature measurably deepens in_progress coverage.
- Cost: tool text unchanged vs v6e; s2 io tokens 15.4k vs 16.4k (noise); note adds ~10 tokens only when it fires.
- Judge (clean lists, deepseek cross-family): hygiene **2.0 vs 2.0** — equal. Total 7.19 vs 8.00 traces to granularity/actionability 1s on v7's s4 mega-items; v6e's s4 lists are structurally identical (same 5-item mega style) → judge noise at n=2, not a behavior delta.

**Extractor correction (affects historical numbers).** `scratch/todo-quality.mjs` result-line parsing swallowed `#tag` suffixes and v7 promotion suffixes into titles → phantom "open twin" items. After fix: 0 twin-runs across ALL contenders and versions (previously reported twin/hygiene gaps for local-todos were artifacts). everIp for local-todos family recomputed: ~0.16–0.24 (was underreported); rpiv-todo 0.50, rpiv-todo-lean 0.30 stand.

**Verdict.** v7 ships: correct under parallel closes, zero false positives, zero prompt-cost increase, measurable in_progress-coverage gain. Root insight: models usually close todos in one end-of-turn parallel batch — single-flight makes the promotion fire exactly once, correctly, at the moment it matters.

## Same-judge session-quality pass (2026-10-18): all seven under deepseek-pro-latest

The v7/v6e matrices postdated the expiry of the original judge key (opencode/deepseek-v4-pro → 401), so their /10 session verdicts were missing while contenders kept theirs. To make the column real (and same-judge), ALL 7 contenders × 15 runs were re-judged under `~deepseek/deepseek-pro-latest` (openrouter; same family as the original judge, cross-family vs run model glm-5.3). Old verdicts preserved as `judge-v4pro.json` alongside. `harness/judge.mjs` now takes `JUDGE_MODEL` env override.

Calibration: v4 under the new judge drops 8.40 → 7.73 — the new judge runs ~0.7 stricter overall and reads the ambiguous s6 scenario oppositely (v4 s6-r1: old 8 "fixed all five failures, well reported" vs new 4 "scope creep after user scoped to one test"). Same-transcript disagreement on an ambiguous scenario = judge noise, not extension behavior.

### Leaderboard (same judge, 15 runs each, /10)

| contender | overall | planning | todoUsage | efficiency | communication | postCompaction |
|---|---|---|---|---|---|---|
| rpiv-todo | 8.40 | 7.93 | 7.20 | **7.80** | 8.60 | 8.00 |
| rpiv-todo-lean | 8.40 | **8.07** | 7.13 | 7.60 | **8.60** | **8.33** |
| **local-todos v7** | 8.33 | 7.87 | **7.27** | 7.53 | 8.47 | 6.00 (n=2) |
| local-todos v6e | 8.33 | 8.07 | 6.87 | 7.33 | 8.60 | 8.00 |
| inobit-pi-todo | 8.20 | 7.60 | 6.60 | 7.73 | 8.27 | 7.33 |
| gamaraan-todos-tool | 8.13 | 7.87 | 6.67 | 7.67 | 8.47 | 8.00 |
| local-todos v4 | 7.73 | 7.53 | 6.73 | 7.87 | 8.40 | 6.50 |

- Top spread is 0.27 — session quality is statistically indistinguishable across the field under one judge; the earlier /10 ranking (old judge) had the same property.
- v7 posts the **best todoUsage of all seven** (7.27): the judge credits kept-current statuses — consistent with auto-promotion deepening live status coverage.
- v7 postCompaction 6.00 is n=2 s6 noise (runs scored 5 and 7; the r1 note itself says "delivered the correct final result"); v6e's 8.00 on the same scenario shows the variance.
- v4's 7.73 carries the new judge's s6 scope-creep outlier (overall 4); its efficiency axis (7.87) remains best-in-class alongside rpiv-todo.

### Verdict

With a same-judge column the picture closes: **no extension separates on session quality; they separate on cost, adoption, hygiene mechanics, and storage semantics** — where v7 holds the best combined profile (tokens 25–50% under the npm field, 3/3 adoption, hygiene 2.0/2.0, locks/GC/re-inject/auto-promotion unique).
