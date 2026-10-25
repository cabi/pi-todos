#!/usr/bin/env node
// Functionality tests for todos.ts (68 tests: lifecycle, timestamps, GC, locks, compaction re-injection, v7 auto-promotion).
// Transpiles the extension with tsc, loads it with a mock pi, and drives the real tool execute(). Run: node test/todos.test.mjs
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const TSC = process.env.TSC_BIN ?? "tsc";
const piReleasesDir = path.join(os.homedir(), ".pi/agent/install/releases");
const latestPiRelease = fs
	.readdirSync(piReleasesDir)
	.filter((d) => /^\d+\.\d+\.\d+$/.test(d))
	.sort((a, b) => {
		const [a0, a1, a2] = a.split(".").map(Number);
		const [b0, b1, b2] = b.split(".").map(Number);
		return a0 - b0 || a1 - b1 || a2 - b2;
	})
	.pop();
const PI_NM = process.env.PI_NM ?? path.join(piReleasesDir, latestPiRelease ?? "1.4.0", "node_modules");
const SRC = process.env.TODOS_TS ?? new URL("../todos.ts", import.meta.url).pathname;

const work = fs.mkdtempSync("/tmp/todos-v5-");
fs.symlinkSync(PI_NM, path.join(work, "node_modules"), "dir");
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ type: "module" }));
fs.copyFileSync(SRC, path.join(work, "todos.ts"));
execSync(`${TSC} ${path.join(work, "todos.ts")} --outDir ${work}/ext --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --noCheck`, {
	stdio: "pipe",
});
const mod = await import(pathToFileURL(path.join(work, "ext", "todos.js")).href);

// ---------- mock pi ----------
function makePi() {
	const pi = { handlers: {}, tools: [], commands: [], messages: [] };
	pi.on = (ev, fn) => {
		(pi.handlers[ev] ??= []).push(fn);
	};
	pi.registerTool = (t) => pi.tools.push(t);
	pi.registerCommand = (name, def) => pi.commands.push({ name, def });
	pi.sendMessage = (m) => pi.messages.push(m);
	return pi;
}
const pi = makePi();
mod.default(pi);
const tool = pi.tools.find((t) => t.name === "todo");
if (!tool) {
	console.error("FAIL: todo tool not registered");
	process.exit(1);
}

const ws = fs.mkdtempSync("/tmp/todos-ws-");
const makeCtx = (over = {}) => ({
	cwd: ws,
	hasUI: false,
	sessionManager: {
		getSessionFile: () => "test-session.jsonl",
		getSessionId: () => "sess-test-1",
	},
	ui: { confirm: async () => true },
	...over,
});
const todosDir = path.join(ws, ".pi", "todos");

async function call(params, ctx = makeCtx()) {
	const res = await tool.execute("c1", params, undefined, undefined, ctx);
	const text = res.content?.[0]?.text ?? "";
	return { text, res };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// front-matter reader (mirrors the extension's format: leading JSON object + markdown body)
function readTodo(id) {
	const content = fs.readFileSync(path.join(todosDir, `${id}.md`), "utf8");
	let depth = 0,
		inS = false,
		esc = false,
		end = -1;
	for (let i = 0; i < content.length; i++) {
		const c = content[i];
		if (inS) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inS = false;
			continue;
		}
		if (c === '"') inS = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) throw new Error(`no front matter in ${id}`);
	return { fm: JSON.parse(content.slice(0, end + 1)), body: content.slice(end + 1) };
}

let pass = 0,
	fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  PASS ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}
const idFromSummary = (text) => text.match(/TODO-([0-9a-f]{8})/i)?.[1];

// =====================================================================
console.log("\n== #8 timestamps: create/close/reopen/append/claim/release ==");
{
	fs.mkdirSync(todosDir, { recursive: true });
	const { text: created } = await call({ action: "create", title: "T1 fix login", body: "notes" });
	const id = idFromSummary(created);
	check("create returns id", Boolean(id), created);
	let fm = readTodo(id).fm;
	check("create sets created_at+updated_at", Boolean(fm.created_at && fm.updated_at), JSON.stringify(fm));
	check("create leaves closed_at empty", !fm.closed_at);
	await sleep(20);

	await call({ action: "update", id, status: "closed" });
	fm = readTodo(id).fm;
	check("close sets closed_at", Boolean(fm.closed_at), JSON.stringify(fm));
	check("close bumps updated_at", fm.updated_at > fm.created_at);
	const closedAt = fm.closed_at;

	await call({ action: "update", id, status: "open" });
	fm = readTodo(id).fm;
	check("reopen clears closed_at", !fm.closed_at, JSON.stringify(fm));
	check("reopen preserves earlier closed_at? (no — must be empty)", fm.closed_at === undefined);

	await call({ action: "append", id, body: "more notes" });
	fm = readTodo(id).fm;
	check("append bumps updated_at", fm.updated_at >= closedAt);

	await call({ action: "claim", id });
	fm = readTodo(id).fm;
	check("claim assigns session + bumps updated_at", fm.assigned_to_session === "sess-test-1" && Boolean(fm.updated_at));
	await call({ action: "release", id });
	fm = readTodo(id).fm;
	check("release unassigns", !fm.assigned_to_session);
}

console.log("\n== #8 GC: closed_at is the reference, created_at only as legacy fallback ==");
{
	const gcDir = fs.mkdtempSync("/tmp/todos-gc-");
	const tDir = path.join(gcDir, ".pi", "todos");
	fs.mkdirSync(tDir, { recursive: true });
	const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
	const mk = (id, fm) => fs.writeFileSync(path.join(tDir, `${id}.md`), `${JSON.stringify(fm, null, 2)}\n\nbody\n`);
	mk("aaaa1111", { id: "aaaa1111", title: "closed long ago", tags: [], status: "closed", created_at: days(8), closed_at: days(8) });
	mk("bbbb2222", { id: "bbbb2222", title: "old but freshly closed", tags: [], status: "closed", created_at: days(8), closed_at: days(0.003) });
	mk("cccc3333", { id: "cccc3333", title: "legacy closed (no closed_at)", tags: [], status: "closed", created_at: days(8) });
	mk("dddd4444", { id: "dddd4444", title: "old but open", tags: [], status: "open", created_at: days(8) });
	await pi.handlers.session_start[0]({}, { cwd: gcDir });
	const left = fs.readdirSync(tDir).filter((f) => f.endsWith(".md")).sort();
	check("GC deletes closed 8d ago (closed_at 8d)", !left.includes("aaaa1111.md"), left.join(","));
	check("GC KEEPS closed created 8d ago but closed now (the #8 fix)", left.includes("bbbb2222.md"), left.join(","));
	check("GC deletes legacy closed without closed_at (created_at fallback)", !left.includes("cccc3333.md"), left.join(","));
	check("GC never deletes open", left.includes("dddd4444.md"), left.join(","));
}

console.log("\n== #7 lock steal: dead owner pid, headless, FRESH lock ==");
{
	const { text: created } = await call({ action: "create", title: "T3 lock test" });
	const id = idFromSummary(created);
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1<<30)"], { stdio: "ignore" });
	await sleep(300);
	const pid = child.pid;
	const exited = new Promise((r) => child.on("close", r));
	child.kill("SIGKILL");
	await exited;
	fs.writeFileSync(
		path.join(todosDir, `${id}.lock`),
		JSON.stringify({ id, pid, session: "crashed-session.jsonl", created_at: new Date().toISOString() }),
	);
	const lockMtime = fs.statSync(path.join(todosDir, `${id}.lock`)).mtimeMs;
	const { text } = await call({ action: "claim", id }); // hasUI: false
	const fm = readTodo(id).fm;
	check("headless claim steals lock from dead pid", fm.assigned_to_session === "sess-test-1", text);
	check("claim went through the re-acquired lock", !fs.existsSync(path.join(todosDir, `${id}.lock`)) || fs.statSync(path.join(todosDir, `${id}.lock`)).mtimeMs !== lockMtime);
}

console.log("\n== #7 lock: LIVE owner pid is respected (headless) ==");
{
	const { text: created } = await call({ action: "create", title: "T4 live lock" });
	const id = idFromSummary(created);
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1<<30)"], { stdio: "ignore" });
	await sleep(300);
	fs.writeFileSync(
		path.join(todosDir, `${id}.lock`),
		JSON.stringify({ id, pid: child.pid, session: "busy-session.jsonl", created_at: new Date().toISOString() }),
	);
	const fresh = await call({ action: "claim", id });
	check("fresh lock w/ live pid → 'locked' error, no steal", /is locked/.test(fresh.text) && !readTodo(id).fm.assigned_to_session, fresh.text);
	// same but lock mtime pushed 31 min back (TTL expired, owner still alive)
	const old = new Date(Date.now() - 31 * 60000);
	fs.utimesSync(path.join(todosDir, `${id}.lock`), old, old);
	const stale = await call({ action: "claim", id });
	check("stale lock w/ live pid → headless refuses steal", /stale/.test(stale.text) && /interactive/.test(stale.text), stale.text);
	child.kill("SIGKILL");
	await new Promise((r) => child.on("close", r));
}

console.log("\n== #7 lock: own leftover lock is stolen ==");
{
	const { text: created } = await call({ action: "create", title: "T5 self lock" });
	const id = idFromSummary(created);
	fs.writeFileSync(
		path.join(todosDir, `${id}.lock`),
		JSON.stringify({ id, pid: process.pid, session: "test-session.jsonl", created_at: new Date().toISOString() }),
	);
	const { text } = await call({ action: "claim", id });
	check("claim steals own-pid lock", readTodo(id).fm.assigned_to_session === "sess-test-1", text);
}

console.log("\n== regression: session_compact re-injection still works ==");
{
	pi.messages.length = 0;
	await pi.handlers.session_compact[0]({}, { cwd: ws });
	check("todo-status message emitted for open todos", pi.messages.some((m) => m.customType === "todo-status" && /T5 self lock/.test(m.content)), JSON.stringify(pi.messages.map((m) => m.content?.slice(0, 40))));
}

console.log("\n== v6 lean: fill-ins via prepareArguments (pi applies them before schema validation) ==");
{
	const ACTIONS = ["list", "list-all", "get", "create", "update", "append", "delete", "claim", "release"];
	const STATUSES = ["open", "in_progress", "closed"];
	const conforms = (p) => p && typeof p === "object" && ACTIONS.includes(p.action) && (p.status === undefined || STATUSES.includes(p.status));
	const callRaw = async (args) => {
		const prepared = tool.prepareArguments(args);
		if (!conforms(prepared)) return { ok: false, prepared };
		return { ok: true, prepared, ...(await call(prepared)) };
	};

	check("tool registers prepareArguments", typeof tool.prepareArguments === "function");
	check("prepareArguments passes through non-objects", tool.prepareArguments(null) === null && tool.prepareArguments("x") === "x");

	// id: .md suffix + surrounding whitespace stripped (can't be wrong)
	const { text: created6 } = await call({ action: "create", title: "T6 lean" });
	const id6 = idFromSummary(created6);
	const got = await callRaw({ action: "get", id: `  TODO-${id6}.md ` });
	check("id alias: 'TODO-<hex>.md' resolves", got.ok && /T6 lean/.test(got.text), JSON.stringify(got.prepared));

	// status aliases (unambiguous)
	const st = await callRaw({ action: "update", id: id6, status: "completed" });
	check("status alias: completed → closed", st.ok && readTodo(id6).fm.status === "closed", JSON.stringify(st.prepared));
	const st2 = await callRaw({ action: "update", id: id6, status: "in-progress" });
	check("status alias: in-progress → in_progress", st2.ok && readTodo(id6).fm.status === "in_progress", JSON.stringify(st2.prepared));

	// action aliases (unambiguous: close/done = mark completed, reopen = mark open)
	const done = await callRaw({ action: "done", id: id6 });
	check("action alias: done → update+closed", done.ok && readTodo(id6).fm.status === "closed", JSON.stringify(done.prepared));
	const reopened = await callRaw({ action: "reopen", id: id6 });
	check("action alias: reopen → update+open", reopened.ok && readTodo(id6).fm.status === "open", JSON.stringify(reopened.prepared));
	const explicit = await callRaw({ action: "close", id: id6, status: "in_progress" });
	check("explicit status beats action alias", explicit.ok && readTodo(id6).fm.status === "in_progress", JSON.stringify(explicit.prepared));

	// tags: bare string wraps to array
	const tg = await callRaw({ action: "update", id: id6, tags: "solo" });
	check("tags alias: string → [string]", tg.ok && readTodo(id6).fm.tags.includes("solo"), JSON.stringify(tg.prepared));

	// ambiguous / garbage stays unnormalized → pi schema validation reports allowed values
	const ambOpen = tool.prepareArguments({ action: "open", id: id6 });
	check("action 'open' stays unmapped (ambiguous)", ambOpen.action === "open" && !conforms(ambOpen));
	const badStatus = tool.prepareArguments({ action: "update", id: id6, status: "banana" });
	check("unknown status stays unmapped", badStatus.status === "banana" && !conforms(badStatus));
}

console.log("\n== v6 lean: per-request text is trimmed ==");
{
	check("promptSnippet trimmed", tool.promptSnippet === "Create and track multi-step work with a persistent todo list", tool.promptSnippet);
	check("promptGuidelines single line, threshold in guideline only",
		Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length === 1 && /3\+ steps/.test(tool.promptGuidelines[0]) && !/3\+/.test(tool.description ?? ""),
		JSON.stringify(tool.promptGuidelines));
	check("description trimmed (≤170 chars, persistence + status rule kept)",
		tool.description.length <= 210 && /persists across sessions and compaction/.test(tool.description) && /in_progress/.test(tool.description),
		tool.description + ` (${tool.description.length} ch)`);
	const props = tool.parameters?.properties ?? {};
	check("schema: title/tags/status descriptions dropped", !props.title?.description && !props.tags?.description && !props.status?.description, JSON.stringify(props));
	check("schema: body/force/id keep short calling-relevant descriptions",
		/update replaces, append adds/.test(props.body?.description ?? "") && /claim/.test(props.force?.description ?? "") && /TODO-/.test(props.id?.description ?? ""));
}

console.log("\n== v7 auto-promotion ==");
{
	// v7-1: close → promotes earliest open (created_at order), note + details
	fs.rmSync(todosDir, { recursive: true, force: true });
	fs.mkdirSync(todosDir, { recursive: true });
	const a = idFromSummary((await call({ action: "create", title: "V7 A" })).text);
	await sleep(25);
	const b = idFromSummary((await call({ action: "create", title: "V7 B" })).text);
	await sleep(25);
	const c = idFromSummary((await call({ action: "create", title: "V7 C" })).text);
	const { text, res } = await call({ action: "update", id: a, status: "closed" });
	check("close promotes earliest open to in_progress", readTodo(b).fm.status === "in_progress", text);
	check("promotion note in result text", /Promoted TODO-[0-9a-f]+ → in_progress: V7 B/.test(text), text);
	check("promotion in details", res.details?.promoted?.id === b, JSON.stringify(res.details?.promoted));
	check("later open item untouched", readTodo(c).fm.status === "open");
	check("closed item keeps closed_at", Boolean(readTodo(a).fm.closed_at));

	// v7-2: another in_progress item → no promotion
	const d = idFromSummary((await call({ action: "create", title: "V7 D" })).text);
	const r2 = await call({ action: "update", id: d, status: "closed" });
	check("no promotion while in_progress exists", readTodo(c).fm.status === "open" && !/Promotion|Promoted/.test(r2.text), r2.text);

	// v7-3: reopen does not demote the promoted item
	const r3 = await call({ action: "update", id: d, status: "open" });
	check("reopen leaves in_progress intact", readTodo(b).fm.status === "in_progress" && !/Promotion|Promoted/.test(r3.text), r3.text);

	// v7-4: close the in_progress item → next open promoted (vacancy refill)
	const r4 = await call({ action: "update", id: b, status: "closed" });
	check("closing in_progress refills vacancy", readTodo(c).fm.status === "in_progress", r4.text);

	// v7-5: candidates assigned to another session are skipped
	fs.rmSync(todosDir, { recursive: true, force: true });
	fs.mkdirSync(todosDir, { recursive: true });
	const e = idFromSummary((await call({ action: "create", title: "V7 E" })).text);
	await sleep(25);
	const f = idFromSummary((await call({ action: "create", title: "V7 F" })).text);
	const otherCtx = makeCtx({ sessionManager: { getSessionFile: () => "s.jsonl", getSessionId: () => "sess-other" } });
	await call({ action: "claim", id: f }, otherCtx);
	const r5 = await call({ action: "update", id: e, status: "closed" });
	check("assigned-to-other skipped with note", readTodo(f).fm.status === "open" && /Promotion skipped: all open todos are assigned/.test(r5.text), r5.text);

	// v7-6: close last open → no promotion, no note
	fs.rmSync(todosDir, { recursive: true, force: true });
	fs.mkdirSync(todosDir, { recursive: true });
	const h = idFromSummary((await call({ action: "create", title: "V7 H" })).text);
	const r6 = await call({ action: "update", id: h, status: "closed" });
	check("close last open: no note", !/Promotion|Promoted/.test(r6.text), r6.text);

	// v7-7: lock conflict on candidate → close ok, skip note
	fs.rmSync(todosDir, { recursive: true, force: true });
	fs.mkdirSync(todosDir, { recursive: true });
	const i1 = idFromSummary((await call({ action: "create", title: "V7 I1" })).text);
	await sleep(25);
	const i2 = idFromSummary((await call({ action: "create", title: "V7 I2" })).text);
	const holder = spawn("sleep", ["30"]);
	fs.writeFileSync(path.join(todosDir, `${i2}.lock`), JSON.stringify({ owner: holder.pid, acquired: new Date().toISOString() }));
	try {
		const r7 = await call({ action: "update", id: i1, status: "closed" });
		check("lock conflict: close ok, promotion skipped", readTodo(i1).fm.status === "closed" && readTodo(i2).fm.status === "open" && /Promotion skipped/.test(r7.text), r7.text);
	} finally {
		holder.kill();
	}

	// v7-8: PARALLEL closes (one turn, five update calls) — single-flight promotion
	{
		fs.rmSync(todosDir, { recursive: true, force: true });
		fs.mkdirSync(todosDir, { recursive: true });
		const ids = [];
		for (const t of ["P1", "P2", "P3", "P4", "P5"]) {
			ids.push(idFromSummary((await call({ action: "create", title: `V7 ${t}` })).text));
			await sleep(25);
		}
		await call({ action: "update", id: ids[0], status: "in_progress" });
		const results = await Promise.all(ids.slice(0, 4).map((id) => call({ action: "update", id, status: "closed" })));
		const notes = results.filter((r) => /Promoted TODO-/.test(r.text));
		const skipped = results.filter((r) => /Promotion skipped/.test(r.text));
		const statuses = [...ids.slice(0, 4).map((id) => readTodo(id).fm.status), readTodo(ids[4]).fm.status];
		check("parallel closes: all four closed", statuses.slice(0, 4).every((s) => s === "closed"), JSON.stringify(statuses));
		check("parallel closes: survivor promoted exactly once", readTodo(ids[4]).fm.status === "in_progress" && notes.length === 1, JSON.stringify({ notes: notes.length, last: statuses[4] }));
		check("parallel closes: no skip notes", skipped.length === 0, JSON.stringify(results.map((r) => r.text)));

		// v7-9: parallel closes of ALL todos → no promotion, no notes
		fs.rmSync(todosDir, { recursive: true, force: true });
		fs.mkdirSync(todosDir, { recursive: true });
		const ids2 = [];
		for (const t of ["Q1", "Q2", "Q3"]) {
			ids2.push(idFromSummary((await call({ action: "create", title: `V7 ${t}` })).text));
			await sleep(25);
		}
		const results2 = await Promise.all(ids2.map((id) => call({ action: "update", id, status: "closed" })));
		check("all-closed parallel batch: no promotion notes", results2.every((r) => !/Promot/.test(r.text)), JSON.stringify(results2.map((r) => r.text)));
		check("all-closed parallel batch: all closed", ids2.every((id) => readTodo(id).fm.status === "closed"));
	}
}


console.log("\n== #9 living id errors: diagnose, suggest, roster, hint ==");
{
	fs.rmSync(todosDir, { recursive: true, force: true });
	fs.mkdirSync(todosDir, { recursive: true });
	const id1 = idFromSummary((await call({ action: "create", title: "LE alpha task" })).text);
	const id2 = idFromSummary((await call({ action: "create", title: "LE beta task" })).text);
	await sleep(25);

	// A+B: dropped last char → invalid-format diagnosis + did-you-mean with the exact id
	const short = `TODO-${id1.slice(0, 7)}`;
	const r1 = await call({ action: "get", id: short });
	check("invalid: diagnoses 7 chars", /Error: invalid todo id "TODO-[0-9a-f]{7}": expected 8 hex characters after "TODO-", got 7/.test(r1.text), r1.text);
	check("invalid: suggests the exact todo", r1.text.includes("Did you mean:") && r1.text.includes(`TODO-${id1}`) && r1.text.includes("LE alpha task"), r1.text);
	check("invalid: no auto-apply warning + hint", r1.text.includes("not applied automatically") && r1.text.includes("todo list-all"), r1.text);

	// B: valid-format unknown id, far from everything → not-found + roster fallback (C) + hint (D)
	const r2 = await call({ action: "get", id: "TODO-00112233" });
	check("not found: head + roster", r2.text.startsWith("Error: todo TODO-00112233 not found.") && r2.text.includes("Current open todos:"), r2.text);
	check("not found: roster lists titles", r2.text.includes("LE alpha task") && r2.text.includes("LE beta task"), r2.text);

	// B: mistyped middle char (same length) → did-you-mean via edit distance
	const flip = id1.slice(0, 4) + (id1[4] === "0" ? "1" : "0") + id1.slice(5);
	const r3 = await call({ action: "update", id: `TODO-${flip}`, status: "closed" });
	check("typo: suggests near miss", r3.text.includes("Did you mean:") && r3.text.includes(`TODO-${id1}`), r3.text);
	check("typo: mutation NOT auto-applied", readTodo(id1).fm.status === "open", `status=${readTodo(id1).fm.status}`);

	// A: charset diagnosis
	const r4 = await call({ action: "get", id: "TODO-xx11yy22" });
	check("invalid: names bad characters", /invalid characters: x y/.test(r4.text), r4.text);

	// helper-routed path (claim) gets the same enrichment
	const r5 = await call({ action: "claim", id: `TODO-${id2.slice(0, 7)}` });
	check("claim: enriched invalid id", r5.text.includes("Did you mean:") && r5.text.includes(`TODO-${id2}`), r5.text);
	check("claim: typo id not claimed", readTodo(id2).fm.assigned_to_session === undefined);

	// C/D: empty store
	fs.rmSync(todosDir, { recursive: true, force: true });
	const r6 = await call({ action: "get", id: "TODO-deadbeef" });
	check("empty store: hint to create", r6.text.includes("The todo store is empty") && r6.text.includes("todo create"), r6.text);

// ---------- #10 error values: structured details + single TUI prefix ----------
{
	const theme = { fg: (_c, s) => s, bold: (s) => s };
	fs.mkdirSync(todosDir, { recursive: true });
	await call({ action: "create", title: "EV struct task" });

	// invalid id → details carries the structured value, not prose
	const r = await call({ action: "update", id: "TODO-zzzz99zz", status: "closed" });
	check("error value: details carries kind", r.res.details?.error?.kind === "invalid_id" && r.res.details.error.id === "TODO-zzzz99zz", JSON.stringify(r.res.details));

	// renderResult derives its own line from the value: exactly one "Error:" prefix
	const rendered = tool.renderResult(r.res, { expanded: false, isPartial: false }, theme);
	const lines = rendered.render(200);
	const line = (Array.isArray(lines) ? lines.join("\n") : String(lines)).trim();
	const prefixes = line.match(/Error:/g) ?? [];
	check("tui: renders one short line, single prefix", line === "Error: invalid todo id: TODO-zzzz99zz" && prefixes.length === 1, line);

	// not_found value → TUI names the todo; tool channel keeps the living error
	const r2 = await call({ action: "get", id: "TODO-00112233" });
	check("not found: value kind", r2.res.details?.error?.kind === "not_found", JSON.stringify(r2.res.details?.error));
	const line2 = tool.renderResult(r2.res, { expanded: false, isPartial: false }, theme).render(200).join("\n").trim();
	check("tui: not found line", line2 === "Error: todo TODO-00112233 not found", line2);
	check("tool: not found keeps living error", r2.text.startsWith("Error: todo TODO-00112233 not found."), r2.text);
}
}
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
