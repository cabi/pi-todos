/**
 * This extension stores todo items as files under <todo-dir> (defaults to .pi/todos,
 * or the path in PI_TODO_PATH).  Each todo is a standalone markdown file named
 * <id>.md and an optional <id>.lock file is used while a session is editing it.
 *
 * File format in .pi/todos:
 * - The file starts with a JSON object (not YAML) containing the front matter:
 *   { id, title, tags, status, created_at, updated_at, closed_at, assigned_to_session }
 * - After the JSON block comes optional markdown body text separated by a blank line.
 * - Example:
 *   {
 *     "id": "deadbeef",
 *     "title": "Add tests",
 *     "tags": ["qa"],
 *     "status": "open",
 *     "created_at": "2026-01-25T17:00:00.000Z",
 *     "assigned_to_session": "session.json"
 *   }
 *
 *   Notes about the work go here.
 *
 * Todo storage settings are kept in <todo-dir>/settings.json.
 * Defaults:
 * {
 *   "gc": true,   // delete closed todos older than gcDays on startup
 *   "gcDays": 7   // age threshold for GC (days since closed_at; falls back to created_at for legacy files)
 * }
 *
 * Use `/todos` to bring up the visual todo manager or just let the LLM use them
 * naturally.
 */
import { DynamicBorder, copyToClipboard, getMarkdownTheme, keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import {
	Container,
	type Focusable,
	Input,
	Key,
	Markdown,
	SelectList,
	Spacer,
	type SelectItem,
	Text,
	TUI,
	fuzzyMatch,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const TODO_SETTINGS_NAME = "settings.json";
const TODO_ID_PREFIX = "TODO-";
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
const DEFAULT_TODO_SETTINGS = {
	gc: true,
	gcDays: 7,
};
const LOCK_TTL_MS = 30 * 60 * 1000;

interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	updated_at?: string;
	closed_at?: string;
	assigned_to_session?: string;
}

interface TodoRecord extends TodoFrontMatter {
	body: string;
}

interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

interface TodoSettings {
	gc: boolean;
	gcDays: number;
}

type KeybindingMatcher = {
	matches: (keyData: string, keybindingId: string) => boolean;
};

const TodoParams = Type.Object({
	action: StringEnum([
		"list",
		"list-all",
		"get",
		"create",
		"update",
		"append",
		"delete",
		"claim",
		"release",
	] as const),
	id: Type.Optional(Type.String({ description: "Todo id (TODO-xxxxxxxx)" })),
	title: Type.Optional(Type.String()),
	status: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("in_progress"), Type.Literal("closed")]),
	),
	tags: Type.Optional(Type.Array(Type.String())),
	body: Type.Optional(Type.String({ description: "markdown; update replaces, append adds" })),
	force: Type.Optional(Type.Boolean({ description: "override another session's claim" })),
});

// Lean fill-ins: normalize unambiguous aliases before schema validation (via the tool's
// prepareArguments shim) so the schema can stay minimal. Ambiguous input is left alone —
// schema validation then reports the allowed values.
const TODO_STATUS_ALIASES: Record<string, "open" | "in_progress" | "closed"> = {
	completed: "closed",
	done: "closed",
	"in-progress": "in_progress",
};

function prepareTodoArguments(args: unknown): Static<typeof TodoParams> {
	if (typeof args !== "object" || args === null) return args as Static<typeof TodoParams>;
	const params = { ...(args as Record<string, unknown>) };
	if (typeof params.id === "string") {
		const id = params.id.trim();
		params.id = id.endsWith(".md") ? id.slice(0, -3) : id;
	}
	if (typeof params.status === "string") {
		const status = params.status.trim().toLowerCase();
		params.status = TODO_STATUS_ALIASES[status] ?? status;
	}
	if (typeof params.tags === "string") params.tags = [params.tags];
	switch (typeof params.action === "string" ? params.action.trim().toLowerCase() : params.action) {
		case "close":
		case "done":
			// close/done unambiguously mean "mark completed"
			params.action = "update";
			if (params.status === undefined) params.status = "closed";
			break;
		case "reopen":
			params.action = "update";
			if (params.status === undefined) params.status = "open";
			break;
		// "open" stays unmapped on purpose: it could mean "get" (read) or "reopen" —
		// ambiguous, so schema validation rejects it with the allowed action list.
	}
	return params as Static<typeof TodoParams>;
}

type TodoAction =
	| "list"
	| "list-all"
	| "get"
	| "create"
	| "update"
	| "append"
	| "delete"
	| "claim"
	| "release";

type TodoOverlayAction = "back" | "work";

type TodoMenuAction =
	| "work"
	| "refine"
	| "close"
	| "reopen"
	| "release"
	| "delete"
	| "copyPath"
	| "copyText"
	| "view";

type TodoErrorKind =
	| "id_required"
	| "invalid_params"
	| "invalid_id"
	| "not_found"
	| "locked"
	| "conflict"
	| "io";

/**
 * Error as a value: the kind plus the payload needed to render it. Renderers own
 * all prose (renderTodoToolError / tuiTodoErrorMessage); the value carries none.
 */
type TodoError = {
	kind: TodoErrorKind;
	/** Raw id as the caller passed it, for id errors. */
	id?: string;
	/** Dynamic payload for locked/conflict/io: lock reason, conflict or io message. */
	detail?: string;
};

type TodoErrorAction = "get" | "create" | "update" | "append" | "delete" | "claim" | "release";

type TodoToolDetails =
	| { action: "list" | "list-all"; todos: TodoFrontMatter[]; currentSessionId?: string; error?: TodoError }
	| {
			action: TodoErrorAction;
			todo?: TodoRecord;
			promoted?: { id: string; title: string };
			error?: TodoError;
		};
function formatTodoId(id: string): string {
	return `${TODO_ID_PREFIX}${id}`;
}

function normalizeTodoId(id: string): string {
	let trimmed = id.trim();
	if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
		trimmed = trimmed.slice(TODO_ID_PREFIX.length);
	}
	return trimmed;
}

/** Normalize and validate a raw id; returns the canonical lowercase id or null. */
function validateTodoId(id: string): string | null {
	const normalized = normalizeTodoId(id);
	if (!normalized || !TODO_ID_PATTERN.test(normalized)) return null;
	return normalized.toLowerCase();
}

function displayTodoId(id: string): string {
	return formatTodoId(normalizeTodoId(id));
}

/**
 * Plain Levenshtein distance. Todo ids are ~8 chars, so the O(n·m) table is
 * trivial; used only on id-error paths to find near-miss candidates.
 */
function levenshtein(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const curr = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		prev = curr;
	}
	return prev[b.length];
}

/** Diagnose *why* an id is invalid (length vs charset), echoing the offending input. */
function describeInvalidTodoId(id: string): string {
	const normalized = normalizeTodoId(id);
	if (!normalized) return `expected 8 hex characters after "TODO-", got nothing`;
	if (normalized.length !== 8) {
		return `expected 8 hex characters after "TODO-", got ${normalized.length} ("${normalized}")`;
	}
	const invalidChars = [...new Set([...normalized].filter((c) => !/[a-f0-9]/i.test(c)))];
	return `expected 8 hex characters (0-9, a-f) after "TODO-", invalid characters: ${invalidChars.join(" ")}`;
}

/**
 * Near-miss candidates for a failed id. Ids are random 8-hex, so two *different*
 * todos sit ~7 edits apart — distance ≤ 2 is almost certainly the todo the model
 * meant (dropped/mistyped char, transposition, extra/missing trailing chars).
 */
function suggestTodosForId(id: string, todos: TodoFrontMatter[]): TodoFrontMatter[] {
	const needle = normalizeTodoId(id).toLowerCase();
	if (!needle) return [];
	return todos
		.map((todo) => ({ todo, distance: levenshtein(needle, todo.id.toLowerCase()) }))
		.filter((s) => s.distance <= 2)
		.sort((a, b) => a.distance - b.distance || a.todo.id.localeCompare(b.todo.id))
		.slice(0, 3)
		.map((s) => s.todo);
}

/**
 * Builds the "living" id error: diagnose the bad id, suggest near misses (never
 * applied automatically), fall back to a roster of open todos, and always name
 * the recovery command. Runs on the error path only — listTodos reads the store.
 */
async function buildTodoIdError(todosDir: string, id: string, kind: "invalid" | "not_found"): Promise<string> {
	let todos: TodoFrontMatter[] = [];
	try {
		todos = await listTodos(todosDir);
	} catch {
		// diagnostics must never turn a clean error into a crash
	}
	const head =
		kind === "invalid"
			? `Error: invalid todo id "${id.trim()}": ${describeInvalidTodoId(id)}.`
			: `Error: todo ${displayTodoId(id)} not found.`;
	const lines = [head];
	const suggestions = suggestTodosForId(id, todos);
	if (suggestions.length) {
		lines.push("Did you mean:");
		for (const todo of suggestions) lines.push(`  ${serializeTodoSummary(todo)}`);
		lines.push("Re-run with the exact id — suggestions are not applied automatically.");
	} else {
		const open = sortTodos(todos.filter((t) => !isTodoClosed(getTodoStatus(t))));
		if (open.length) {
			lines.push("Current open todos:");
			for (const todo of open.slice(0, 5)) lines.push(`  ${serializeTodoSummary(todo)}`);
			if (open.length > 5) lines.push(`  ... and ${open.length - 5} more`);
		} else if (todos.length) {
			lines.push("No open todos — only closed ones remain (todo list-all shows them).");
		} else {
			lines.push("The todo store is empty — create todos first (todo create).");
		}
	}
	lines.push("Run todo list (open+assigned) or todo list-all (includes closed) to see all ids with titles.");
	return lines.join("\n");
}

function isTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}

function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
	if (isTodoClosed(getTodoStatus(todo))) {
		todo.assigned_to_session = undefined;
	}
}

/**
 * Stamp updated_at on every mutation; maintain closed_at as the authoritative
 * "when this todo was closed" timestamp (set on first close, cleared on reopen).
 */
function touchTodo(todo: TodoFrontMatter): void {
	todo.updated_at = new Date().toISOString();
	if (isTodoClosed(getTodoStatus(todo))) {
		if (!todo.closed_at) todo.closed_at = todo.updated_at;
	} else {
		todo.closed_at = undefined;
	}
}

function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
	return [...todos].sort((a, b) => {
		const aClosed = isTodoClosed(a.status);
		const bClosed = isTodoClosed(b.status);
		if (aClosed !== bClosed) return aClosed ? 1 : -1;
		const aAssigned = !aClosed && Boolean(a.assigned_to_session);
		const bAssigned = !bClosed && Boolean(b.assigned_to_session);
		if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
		return (a.created_at || "").localeCompare(b.created_at || "");
	});
}

function buildTodoSearchText(todo: TodoFrontMatter): string {
	const tags = todo.tags.join(" ");
	const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : "";
	return `${formatTodoId(todo.id)} ${todo.id} ${todo.title} ${tags} ${todo.status} ${assignment}`.trim();
}

function filterTodos(todos: TodoFrontMatter[], query: string): TodoFrontMatter[] {
	const trimmed = query.trim();
	if (!trimmed) return todos;

	const tokens = trimmed
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);

	if (tokens.length === 0) return todos;

	const matches: Array<{ todo: TodoFrontMatter; score: number }> = [];
	for (const todo of todos) {
		const text = buildTodoSearchText(todo);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) {
			matches.push({ todo, score: totalScore });
		}
	}

	return matches
		.sort((a, b) => {
			const aClosed = isTodoClosed(a.todo.status);
			const bClosed = isTodoClosed(b.todo.status);
			if (aClosed !== bClosed) return aClosed ? 1 : -1;
			const aAssigned = !aClosed && Boolean(a.todo.assigned_to_session);
			const bAssigned = !bClosed && Boolean(b.todo.assigned_to_session);
			if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
			return a.score - b.score;
		})
		.map((match) => match.todo);
}

class TodoSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allTodos: TodoFrontMatter[];
	private filteredTodos: TodoFrontMatter[];
	private selectedIndex = 0;
	private onSelectCallback: (todo: TodoFrontMatter) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingMatcher;
	private headerText: Text;
	private hintText: Text;
	private currentSessionId?: string;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingMatcher,
		todos: TodoFrontMatter[],
		onSelect: (todo: TodoFrontMatter) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		currentSessionId?: string,
		private onQuickAction?: (todo: TodoFrontMatter, action: "work" | "refine") => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.currentSessionId = currentSessionId;
		this.allTodos = todos;
		this.filteredTodos = todos;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.updateHints();
		this.applyFilter(this.searchInput.getValue());
	}

	setTodos(todos: TodoFrontMatter[]): void {
		this.allTodos = todos;
		this.updateHeader();
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	getSearchValue(): string {
		return this.searchInput.getValue();
	}

	private updateHeader(): void {
		const openCount = this.allTodos.filter((todo) => !isTodoClosed(todo.status)).length;
		const closedCount = this.allTodos.length - openCount;
		const title = `Todos (${openCount} open, ${closedCount} closed)`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateHints(): void {
		this.hintText.setText(
			this.theme.fg(
				"dim",
				"Type to search • ↑↓ select • Enter actions • Ctrl+Shift+W work • Ctrl+Shift+R refine • Esc close",
			),
		);
	}

	private applyFilter(query: string): void {
		this.filteredTodos = filterTodos(this.allTodos, query);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTodos.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredTodos.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching todos"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredTodos.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredTodos.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const todo = this.filteredTodos[i];
			if (!todo) continue;
			const isSelected = i === this.selectedIndex;
			const closed = isTodoClosed(todo.status);
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const titleColor = isSelected ? "accent" : closed ? "dim" : "text";
			const statusColor = closed ? "dim" : "success";
			const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
			const assignmentText = renderAssignmentSuffix(this.theme, todo, this.currentSessionId);
			const line =
				prefix +
				this.theme.fg("accent", formatTodoId(todo.id)) +
				" " +
				this.theme.fg(titleColor, todo.title || "(untitled)") +
				this.theme.fg("muted", tagText) +
				assignmentText +
				" " +
				this.theme.fg(statusColor, `(${todo.status || "open"})`);
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredTodos.length) {
			const scrollInfo = this.theme.fg(
				"dim",
				`  (${this.selectedIndex + 1}/${this.filteredTodos.length})`,
			);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredTodos.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredTodos.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("r"))) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected && this.onQuickAction) this.onQuickAction(selected, "refine");
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("w"))) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected && this.onQuickAction) this.onQuickAction(selected, "work");
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}
}

class TodoActionMenuComponent extends Container {
	private selectList: SelectList;
	private onSelectCallback: (action: TodoMenuAction) => void;
	private onCancelCallback: () => void;

	constructor(
		theme: Theme,
		todo: TodoRecord,
		onSelect: (action: TodoMenuAction) => void,
		onCancel: () => void,
	) {
		super();
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const closed = isTodoClosed(todo.status);
		const title = todo.title || "(untitled)";
		const options: SelectItem[] = [
			{ value: "view", label: "view", description: "View todo" },
			{ value: "work", label: "work", description: "Work on todo" },
			{ value: "refine", label: "refine", description: "Refine task" },
			...(closed
				? [{ value: "reopen", label: "reopen", description: "Reopen todo" }]
				: [{ value: "close", label: "close", description: "Close todo" }]),
			...(todo.assigned_to_session
				? [{ value: "release", label: "release", description: "Release assignment" }]
				: []),
			{ value: "copyPath", label: "copy path", description: "Copy absolute path to clipboard" },
			{ value: "copyText", label: "copy text", description: "Copy title and body to clipboard" },
			{ value: "delete", label: "delete", description: "Delete todo" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(
			new Text(
				theme.fg(
					"accent",
					theme.bold(`Actions for ${formatTodoId(todo.id)} "${title}"`),
				),
			),
		);

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onSelectCallback(item.value as TodoMenuAction);
		this.selectList.onCancel = () => this.onCancelCallback();

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

}

class TodoDeleteConfirmComponent extends Container {
	private selectList: SelectList;
	private onConfirm: (confirmed: boolean) => void;

	constructor(theme: Theme, message: string, onConfirm: (confirmed: boolean) => void) {
		super();
		this.onConfirm = onConfirm;

		const options: SelectItem[] = [
			{ value: "yes", label: "Yes" },
			{ value: "no", label: "No" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", message)));

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onConfirm(item.value === "yes");
		this.selectList.onCancel = () => this.onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}
}

class TodoDetailOverlayComponent {
	private todo: TodoRecord;
	private theme: Theme;
	private tui: TUI;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onAction: (action: TodoOverlayAction) => void;
	private keybindings: KeybindingMatcher;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingMatcher,
		todo: TodoRecord,
		onAction: (action: TodoOverlayAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.todo = todo;
		this.onAction = onAction;
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMarkdownText(): string {
		const body = this.todo.body?.trim();
		return body ? body : "_No details yet._";
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onAction("back");
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onAction("work");
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp") || matchesKey(keyData, Key.left)) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown") || matchesKey(keyData, Key.right)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = this.getMaxHeight();
		const headerLines = 3;
		const footerLines = 3;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];

		lines.push(this.buildTitleLine(innerWidth));
		lines.push(this.buildMetaLine(innerWidth));
		lines.push("");

		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}

		lines.push("");
		lines.push(this.buildActionLine(innerWidth));

		const borderColor = (text: string) => this.theme.fg("borderMuted", text);
		const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		});

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.8));
	}

	private buildTitleLine(width: number): string {
		const titleText = this.todo.title
			? ` ${this.todo.title} `
			: ` Todo ${formatTodoId(this.todo.id)} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("borderMuted", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		const status = this.todo.status || "open";
		const statusColor = isTodoClosed(status) ? "dim" : "success";
		const tagText = this.todo.tags.length ? this.todo.tags.join(", ") : "no tags";
		const line =
			this.theme.fg("accent", formatTodoId(this.todo.id)) +
			this.theme.fg("muted", " • ") +
			this.theme.fg(statusColor, status) +
			this.theme.fg("muted", " • ") +
			this.theme.fg("muted", tagText);
		return truncateToWidth(line, width);
	}

	private buildActionLine(width: number): string {
		const work = this.theme.fg("accent", "enter") + this.theme.fg("muted", " work on todo");
		const back = this.theme.fg("dim", "esc back");
		const nav = this.theme.fg("dim", "↑/↓: move. ←/→: page.");
		const pieces = [work, back, nav];

		let line = pieces.join(this.theme.fg("muted", " • "));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			const scrollInfo = this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
			line += scrollInfo;
		}

		return truncateToWidth(line, width);
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}
}

function getTodosDir(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, TODO_DIR_NAME);
}

function getTodosDirLabel(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return TODO_DIR_NAME;
}

function getTodoSettingsPath(todosDir: string): string {
	return path.join(todosDir, TODO_SETTINGS_NAME);
}

function normalizeTodoSettings(raw: Partial<TodoSettings>): TodoSettings {
	const gc = raw.gc ?? DEFAULT_TODO_SETTINGS.gc;
	const gcDays = Number.isFinite(raw.gcDays) ? raw.gcDays : DEFAULT_TODO_SETTINGS.gcDays;
	return {
		gc: Boolean(gc),
		gcDays: Math.max(0, Math.floor(gcDays)),
	};
}

async function readTodoSettings(todosDir: string): Promise<TodoSettings> {
	const settingsPath = getTodoSettingsPath(todosDir);
	let data: Partial<TodoSettings> = {};

	try {
		const raw = await fs.readFile(settingsPath, "utf8");
		data = JSON.parse(raw) as Partial<TodoSettings>;
	} catch {
		data = {};
	}

	return normalizeTodoSettings(data);
}

async function garbageCollectTodos(todosDir: string, settings: TodoSettings): Promise<void> {
	if (!settings.gc) return;

	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return;
	}

	const cutoff = Date.now() - settings.gcDays * 24 * 60 * 60 * 1000;
	await Promise.all(
		entries
			.filter((entry) => entry.endsWith(".md"))
			.map(async (entry) => {
				const id = entry.slice(0, -3);
				const filePath = path.join(todosDir, entry);
				try {
					const content = await fs.readFile(filePath, "utf8");
					const { frontMatter } = splitFrontMatter(content);
					const parsed = parseFrontMatter(frontMatter, id);
					if (!isTodoClosed(parsed.status)) return;
					// Age is measured from closed_at; legacy files without it fall back to created_at.
					const closedAt = parsed.closed_at ? Date.parse(parsed.closed_at) : NaN;
					const createdAt = Date.parse(parsed.created_at);
					const reference = Number.isFinite(closedAt) ? closedAt : createdAt;
					if (!Number.isFinite(reference)) return;
					if (reference < cutoff) {
						await fs.unlink(filePath);
					}
				} catch {
					// ignore unreadable todo
				}
			}),
	);
}

function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
}

function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
	const data: TodoFrontMatter = {
		id: idFallback,
		title: "",
		tags: [],
		status: "open",
		created_at: "",
		assigned_to_session: undefined,
	};

	const trimmed = text.trim();
	if (!trimmed) return data;

	try {
		const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
		if (!parsed || typeof parsed !== "object") return data;
		if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
		if (typeof parsed.title === "string") data.title = parsed.title;
		if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
		if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
		if (typeof parsed.updated_at === "string" && parsed.updated_at) data.updated_at = parsed.updated_at;
		if (typeof parsed.closed_at === "string" && parsed.closed_at) data.closed_at = parsed.closed_at;
		if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
			data.assigned_to_session = parsed.assigned_to_session;
		}
		if (Array.isArray(parsed.tags)) {
			data.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
		}
	} catch {
		return data;
	}

	return data;
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === "\"") {
				inString = false;
			}
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}

		if (char === "{") {
			depth += 1;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}

	return -1;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
	if (!content.startsWith("{")) {
		return { frontMatter: "", body: content };
	}

	const endIndex = findJsonObjectEnd(content);
	if (endIndex === -1) {
		return { frontMatter: "", body: content };
	}

	const frontMatter = content.slice(0, endIndex + 1);
	const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
	return { frontMatter, body };
}

function parseTodoContent(content: string, idFallback: string): TodoRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseFrontMatter(frontMatter, idFallback);
	return {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags ?? [],
		status: parsed.status,
		created_at: parsed.created_at,
		updated_at: parsed.updated_at,
		closed_at: parsed.closed_at,
		assigned_to_session: parsed.assigned_to_session,
		body: body ?? "",
	};
}

function serializeTodo(todo: TodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			updated_at: todo.updated_at || undefined,
			closed_at: todo.closed_at || undefined,
			assigned_to_session: todo.assigned_to_session || undefined,
		},
		null,
		2,
	);

	const body = todo.body ?? "";
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!trimmedBody) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${trimmedBody}\n`;
}

async function ensureTodosDir(todosDir: string) {
	await fs.mkdir(todosDir, { recursive: true });
}

async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseTodoContent(content, idFallback);
}

async function writeTodoFile(filePath: string, todo: TodoRecord) {
	await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		const todoPath = getTodoPath(todosDir, id);
		if (!existsSync(todoPath)) return id;
	}
	throw new Error("Failed to generate unique todo id");
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

/**
 * Best-effort liveness check via signal 0. EPERM means the process exists but is
 * owned by another user; any other error (ESRCH) means it is gone.
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

async function acquireLock(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | TodoError> {
	const lockPath = getLockPath(todosDir, id);
	const now = Date.now();
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const info: LockInfo = {
				id,
				pid: process.pid,
				session,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch {
					// ignore
				}
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				return { kind: "io", detail: `Failed to acquire lock: ${error?.message ?? "unknown error"}` };
			}
			const stats = await fs.stat(lockPath).catch(() => null);
			const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
			const info = await readLockInfo(lockPath);
			// A lock whose owning process is gone (or is our own leftover) is safe to steal
			// in any mode, regardless of TTL — headless workers must not dead-lock on a
			// crashed predecessor holding a fresh lock.
			const ownerPid = typeof info?.pid === "number" ? info.pid : null;
			if (ownerPid === process.pid || (ownerPid !== null && !isProcessAlive(ownerPid))) {
				await fs.unlink(lockPath).catch(() => undefined);
				continue;
			}
			if (lockAge <= LOCK_TTL_MS) {
				const owner = info?.session ? ` (session ${info.session})` : "";
				return { kind: "locked", detail: `Todo ${displayTodoId(id)} is locked${owner}. Try again later.` };
			}
			if (!ctx.hasUI) {
				return {
					kind: "locked",
					detail: `Todo ${displayTodoId(id)} lock is stale (owner pid ${ownerPid ?? "unknown"} still running); rerun in interactive mode to steal it.`,
				};
			}
			const ok = await ctx.ui.confirm(
				"Todo locked",
				`Todo ${displayTodoId(id)} appears locked. Steal the lock?`,
			);
			if (!ok) {
				return { kind: "locked", detail: `Todo ${displayTodoId(id)} remains locked.` };
			}
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { kind: "locked", detail: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<T>,
): Promise<T | TodoError> {
	const lock = await acquireLock(todosDir, id, ctx);
	if (typeof lock !== "function") return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}

async function listTodos(todosDir: string): Promise<TodoFrontMatter[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return [];
	}

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
				assigned_to_session: parsed.assigned_to_session,
			});
		} catch {
			// ignore unreadable todo
		}
	}

	return sortTodos(todos);
}


function getTodoTitle(todo: TodoFrontMatter): string {
	return todo.title || "(untitled)";
}

const STATUS_ALIASES: Record<string, string> = {
	done: "closed",
	complete: "closed",
	completed: "closed",
	finished: "closed",
	cancelled: "closed",
	pending: "open",
	new: "open",
	created: "open",
	active: "in_progress",
	wip: "in_progress",
	"in-progress": "in_progress",
	working: "in_progress",
};

/** Normalizes legacy/free-form statuses to the canonical open | in_progress | closed set. */
function getTodoStatus(todo: TodoFrontMatter): string {
	const raw = (todo.status || "open").trim().toLowerCase();
	return STATUS_ALIASES[raw] ?? (["open", "in_progress", "closed"].includes(raw) ? raw : "open");
}

function formatAssignmentSuffix(todo: TodoFrontMatter): string {
	return todo.assigned_to_session ? ` (assigned: ${todo.assigned_to_session})` : "";
}

function renderAssignmentSuffix(
	theme: Theme,
	todo: TodoFrontMatter,
	currentSessionId?: string,
): string {
	if (!todo.assigned_to_session) return "";
	const isCurrent = todo.assigned_to_session === currentSessionId;
	const color = isCurrent ? "success" : "dim";
	const suffix = isCurrent ? ", current" : "";
	return theme.fg(color, ` (assigned: ${todo.assigned_to_session}${suffix})`);
}

function formatTodoHeading(todo: TodoFrontMatter): string {
	const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
	return `${formatTodoId(todo.id)} ${getTodoTitle(todo)}${tagText}${formatAssignmentSuffix(todo)}`;
}

function buildRefinePrompt(todoId: string, title: string): string {
	return (
		`let's refine task ${formatTodoId(todoId)} "${title}": ` +
		"Ask me for the missing details needed to refine the todo together. Do not rewrite the todo yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before drafting any structured description.\n\n"
	);
}

function splitTodosByAssignment(todos: TodoFrontMatter[]): {
	assignedTodos: TodoFrontMatter[];
	openTodos: TodoFrontMatter[];
	closedTodos: TodoFrontMatter[];
} {
	const assignedTodos: TodoFrontMatter[] = [];
	const openTodos: TodoFrontMatter[] = [];
	const closedTodos: TodoFrontMatter[] = [];
	for (const todo of todos) {
		if (isTodoClosed(getTodoStatus(todo))) {
			closedTodos.push(todo);
			continue;
		}
		if (todo.assigned_to_session) {
			assignedTodos.push(todo);
		} else {
			openTodos.push(todo);
		}
	}
	return { assignedTodos, openTodos, closedTodos };
}

function formatTodoList(todos: TodoFrontMatter[]): string {
	if (!todos.length) return "No todos.";

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(`${label} (${sectionTodos.length}):`);
		if (!sectionTodos.length) {
			lines.push("  none");
			return;
		}
		for (const todo of sectionTodos) {
			lines.push(`  ${formatTodoHeading(todo)}`);
		}
	};

	pushSection("Assigned todos", assignedTodos);
	pushSection("Open todos", openTodos);
	pushSection("Closed todos", closedTodos);
	return lines.join("\n");
}

function serializeTodoForAgent(todo: TodoRecord): string {
	const payload = { ...todo, id: formatTodoId(todo.id), status: getTodoStatus(todo) };
	return JSON.stringify(payload, null, 2);
}

/** Compact one-line form used in list output and mutation confirmations. */
function serializeTodoSummary(todo: TodoFrontMatter): string {
	const tags = todo.tags.length ? ` #${todo.tags.join(" #")}` : "";
	const assignment = todo.assigned_to_session ? ` (assigned: ${todo.assigned_to_session})` : "";
	return `${formatTodoId(todo.id)} [${getTodoStatus(todo)}] ${getTodoTitle(todo)}${tags}${assignment}`;
}

function serializeTodoListForAgent(todos: TodoFrontMatter[]): string {
	if (!todos.length) return "No todos.";
	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		if (!sectionTodos.length && label !== "open") return;
		lines.push(`${label} (${sectionTodos.length}):`);
		if (!sectionTodos.length) lines.push("  none");
		for (const todo of sectionTodos) lines.push(`  ${serializeTodoSummary(todo)}`);
	};
	pushSection("assigned", assignedTodos);
	pushSection("open", openTodos);
	pushSection("closed", closedTodos);
	return lines.join("\n");
}

function renderTodoHeading(theme: Theme, todo: TodoFrontMatter, currentSessionId?: string): string {
	const closed = isTodoClosed(getTodoStatus(todo));
	const titleColor = closed ? "dim" : "text";
	const tagText = todo.tags.length ? theme.fg("dim", ` [${todo.tags.join(", ")}]`) : "";
	const assignmentText = renderAssignmentSuffix(theme, todo, currentSessionId);
	return (
		theme.fg("accent", formatTodoId(todo.id)) +
		" " +
		theme.fg(titleColor, getTodoTitle(todo)) +
		tagText +
		assignmentText
	);
}

function renderTodoList(
	theme: Theme,
	todos: TodoFrontMatter[],
	expanded: boolean,
	currentSessionId?: string,
): string {
	if (!todos.length) return theme.fg("dim", "No todos");

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(theme.fg("muted", `${label} (${sectionTodos.length})`));
		if (!sectionTodos.length) {
			lines.push(theme.fg("dim", "  none"));
			return;
		}
		const maxItems = expanded ? sectionTodos.length : Math.min(sectionTodos.length, 3);
		for (let i = 0; i < maxItems; i++) {
			lines.push(`  ${renderTodoHeading(theme, sectionTodos[i], currentSessionId)}`);
		}
		if (!expanded && sectionTodos.length > maxItems) {
			lines.push(theme.fg("dim", `  ... ${sectionTodos.length - maxItems} more`));
		}
	};

	const sections: Array<{ label: string; todos: TodoFrontMatter[] }> = [
		{ label: "Assigned todos", todos: assignedTodos },
		{ label: "Open todos", todos: openTodos },
		{ label: "Closed todos", todos: closedTodos },
	];

	sections.forEach((section, index) => {
		if (index > 0) lines.push("");
		pushSection(section.label, section.todos);
	});

	return lines.join("\n");
}

function renderTodoDetail(theme: Theme, todo: TodoRecord, expanded: boolean): string {
	const summary = renderTodoHeading(theme, todo);
	if (!expanded) return summary;

	const tags = todo.tags.length ? todo.tags.join(", ") : "none";
	const createdAt = todo.created_at || "unknown";
	const bodyText = todo.body?.trim() ? todo.body.trim() : "No details yet.";
	const bodyLines = bodyText.split("\n");

	const lines = [
		summary,
		theme.fg("muted", `Status: ${getTodoStatus(todo)}`),
		theme.fg("muted", `Tags: ${tags}`),
		theme.fg("muted", `Created: ${createdAt}`),
		"",
		theme.fg("muted", "Body:"),
		...bodyLines.map((line) => theme.fg("text", `  ${line}`)),
	];

	return lines.join("\n");
}

function appendExpandHint(theme: Theme, text: string): string {
	return `${text}\n${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`;
}

async function ensureTodoExists(filePath: string, id: string): Promise<TodoRecord | null> {
	if (!existsSync(filePath)) return null;
	return readTodoFile(filePath, id);
}

async function appendTodoBody(filePath: string, todo: TodoRecord, text: string): Promise<TodoRecord> {
	const spacer = todo.body.trim().length ? "\n\n" : "";
	todo.body = `${todo.body.replace(/\s+$/, "")}${spacer}${text.trim()}\n`;
	touchTodo(todo);
	await writeTodoFile(filePath, todo);
	return todo;
}

// v7 single-flight close tracking: when several closes run in parallel (one
// assistant turn issues five update calls), only the LAST one to finish may
// promote — earlier ones would either see a still-open in_progress sibling
// (no-op) or read files mid-write (phantom states). Keyed by todosDir.
const closeFlights = new Map<string, { active: number }>();

/**
 * Runs `closeWrite`, then — when no sibling close is still in flight for this
 * todosDir — performs the vacancy promotion. Returns the write result plus the
 * promotion outcome (null for all but the last finisher).
 */
async function closeWithPromotion<T extends { status?: string }>(
	todosDir: string,
	ctx: ExtensionContext,
	excludeId: string,
	closeWrite: () => Promise<T>,
): Promise<{ out: T; promo: { id: string; title: string } | { skipped: string } | null }> {
	const st = closeFlights.get(todosDir) ?? { active: 0 };
	closeFlights.set(todosDir, st);
	st.active++;
	let out: T;
	try {
		out = await closeWrite();
	} finally {
		st.active--;
	}
	if (st.active > 0 || typeof out === "object" && "kind" in out) return { out, promo: null };
	const promo = isTodoClosed(String(out.status ?? "")) ? await promoteNextOpenTodo(todosDir, ctx, excludeId) : null;
	return { out, promo };
}

type ResolvedTodoId = { id: string; filePath: string };

/**
 * Resolve an action's id parameter: present, well-formed, and pointing at an
 * existing todo file. Failures come back as TodoError values (id_required,
 * invalid_id, not_found) that the caller routes through its error channel.
 */
function resolveTodoId(todosDir: string, rawId: string | undefined): ResolvedTodoId | TodoError {
	if (!rawId) return { kind: "id_required" };
	const id = validateTodoId(rawId);
	if (id === null) return { kind: "invalid_id", id: rawId };
	const filePath = getTodoPath(todosDir, id);
	if (!existsSync(filePath)) return { kind: "not_found", id: rawId };
	return { id, filePath };
}

async function updateTodoStatus(
	todosDir: string,
	id: string,
	status: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | TodoError> {
	const resolved = resolveTodoId(todosDir, id);
	if ("kind" in resolved) return resolved;
	const { id: normalizedId, filePath } = resolved;

	const { out: result } = await closeWithPromotion(todosDir, ctx, normalizedId, () =>
		withTodoLock(todosDir, normalizedId, ctx, async () => {
			const existing = await ensureTodoExists(filePath, normalizedId);
			if (!existing) return { kind: "not_found", id };
			existing.status = status;
			clearAssignmentIfClosed(existing);
			touchTodo(existing);
			await writeTodoFile(filePath, existing);
			return existing;
		}),
	);

	return result;
}

/**
 * v7 auto-promotion: after a todo closes, if no open todo is in_progress,
 * promote the first open todo in list display order (skipping todos assigned
 * to other sessions) so the list always points at the current work.
 * Fills vacancies only — never demotes parallel in_progress items.
 */
async function promoteNextOpenTodo(
	todosDir: string,
	ctx: ExtensionContext,
	excludeId?: string,
): Promise<{ id: string; title: string } | { skipped: string } | null> {
	let todos: TodoFrontMatter[] = [];
	try {
		todos = await listTodos(todosDir);
	} catch {
		return null;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const open = todos.filter((t) => !isTodoClosed(t.status) && t.id !== excludeId);
	if (open.length === 0) return null;
	if (open.some((t) => t.status === "in_progress")) return null;
	const candidate = open.find((t) => !t.assigned_to_session || t.assigned_to_session === sessionId);
	if (!candidate) return { skipped: "all open todos are assigned to other sessions" };

	const filePath = getTodoPath(todosDir, candidate.id);
	if (!existsSync(filePath)) return { skipped: "candidate vanished" };
	const outcome = await withTodoLock(todosDir, candidate.id, ctx, async () => {
		const existing = await ensureTodoExists(filePath, candidate.id);
		if (!existing) return { kind: "not_found", detail: "candidate vanished" };
		if (isTodoClosed(existing.status) || existing.status === "in_progress") return null;
		existing.status = "in_progress";
		touchTodo(existing);
		await writeTodoFile(filePath, existing);
		return existing;
	});
	if (outcome === null) return { skipped: "state changed concurrently" };
	if (typeof outcome === "object" && "kind" in outcome) return { skipped: outcome.detail ?? outcome.kind };
	return { id: candidate.id, title: candidate.title };
}

function promotionNote(promo: { id: string; title: string } | { skipped: string } | null): string {
	if (!promo) return "";
	if ("skipped" in promo) return ` Promotion skipped: ${promo.skipped}.`;
	return ` Promoted ${formatTodoId(promo.id)} → in_progress: ${promo.title}`;
}
async function claimTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | TodoError> {
	const resolved = resolveTodoId(todosDir, id);
	if ("kind" in resolved) return resolved;
	const { id: normalizedId, filePath } = resolved;
	const sessionId = ctx.sessionManager.getSessionId();
	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { kind: "not_found", id };
		if (isTodoClosed(existing.status)) {
			return { kind: "conflict", detail: `Todo ${displayTodoId(id)} is closed` };
		}
		const assigned = existing.assigned_to_session;
		if (assigned && assigned !== sessionId && !force) {
			return {
				kind: "conflict",
				detail: `Todo ${displayTodoId(id)} is already assigned to session ${assigned}. Use force to override.`,
			};
		}
		if (assigned !== sessionId) {
			existing.assigned_to_session = sessionId;
			touchTodo(existing);
			await writeTodoFile(filePath, existing);
		}
		return existing;
	});

	return result;
}

async function releaseTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | TodoError> {
	const resolved = resolveTodoId(todosDir, id);
	if ("kind" in resolved) return resolved;
	const { id: normalizedId, filePath } = resolved;
	const sessionId = ctx.sessionManager.getSessionId();
	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { kind: "not_found", id };
		const assigned = existing.assigned_to_session;
		if (!assigned) {
			return existing;
		}
		if (assigned !== sessionId && !force) {
		return {
			kind: "conflict",
			detail: `Todo ${displayTodoId(id)} is assigned to session ${assigned}. Use force to release.`,
		};
		}
		existing.assigned_to_session = undefined;
		touchTodo(existing);
		await writeTodoFile(filePath, existing);
		return existing;
	});

	return result;
}

async function deleteTodo(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | TodoError> {
	const resolved = resolveTodoId(todosDir, id);
	if ("kind" in resolved) return resolved;
	const { id: normalizedId, filePath } = resolved;

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { kind: "not_found", id };
		await fs.unlink(filePath);
		return existing;
	});

	return result;
}

/** Tool-channel renderer: the full agent-facing text for an error value. */
async function renderTodoToolError(todosDir: string, err: TodoError): Promise<string> {
	switch (err.kind) {
		case "id_required":
			return "Error: id required";
		case "invalid_params":
			return `Error: ${err.detail ?? "invalid parameters"}`;
		case "invalid_id":
			return buildTodoIdError(todosDir, err.id ?? "", "invalid");
		case "not_found":
			return buildTodoIdError(todosDir, err.id ?? "", "not_found");
		default:
			return err.detail ?? "Error: todo operation failed";
	}
}

/** TUI-channel renderer: one short line; the caller adds the "Error: " prefix exactly once. */
function tuiTodoErrorMessage(err: TodoError): string {
	switch (err.kind) {
		case "id_required":
			return "an id is required for this action";
		case "invalid_params":
			return err.detail ?? "invalid parameters";
		case "invalid_id":
			return `invalid todo id${err.id ? `: ${err.id}` : ""}`;
		case "not_found":
			return `todo ${err.id ? formatTodoId(normalizeTodoId(err.id)) : "(unknown)"} not found`;
		default:
			return err.detail ?? "todo operation failed";
	}
}

/** Shape an error value into a tool result: rendered text plus the value in details. */
async function toolErrorResult(todosDir: string, action: TodoErrorAction, err: TodoError) {
	return {
		content: [{ type: "text" as const, text: await renderTodoToolError(todosDir, err) }],
		details: { action, error: err },
	};
}

export default function todosExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const todosDir = getTodosDir(ctx.cwd);
		await ensureTodosDir(todosDir);
		const settings = await readTodoSettings(todosDir);
		await garbageCollectTodos(todosDir, settings);
	});

	// After compaction the in-conversation todo state is gone; re-inject the open todos
	// from disk so the agent keeps tracking them (file-based state survives, context does not).
	pi.on("session_compact", async (_event, ctx) => {
		try {
			const todosDir = getTodosDir(ctx.cwd);
			const todos = await listTodos(todosDir);
			const open = todos.filter((t) => !isTodoClosed(getTodoStatus(t)));
			if (!open.length) return;
			const lines = open.map(
				(t) => `  ${formatTodoId(t.id)} [${getTodoStatus(t)}] ${getTodoTitle(t)}`,
			);
			pi.sendMessage({
				customType: "todo-status",
				content:
					`Open todos (from ${getTodosDirLabel(ctx.cwd)}): keep tracking these — ` +
					"set status in_progress when you start an item, closed when done.\n" +
					lines.join("\n"),
				display: true,
				details: { todos: open },
			});
		} catch {
			// never block compaction on todo state
		}
	});


	pi.registerTool({
		name: "todo",
		label: "Todo",
		promptSnippet: "Create and track multi-step work with a persistent todo list",
		promptGuidelines: ["For any task with 3+ steps, create todos first with the todo tool and keep statuses (in_progress/closed) current as you work."],
		description:
			"File-backed todo list that persists across sessions and compaction. " +
			"Create todos first for multi-step tasks; set status in_progress while working on an item, closed when done.",
		parameters: TodoParams,
		prepareArguments: prepareTodoArguments,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const todosDir = getTodosDir(ctx.cwd);
			const action: TodoAction = params.action;

			switch (action) {
				case "list": {
					const todos = await listTodos(todosDir);
					const { assignedTodos, openTodos } = splitTodosByAssignment(todos);
					const listedTodos = [...assignedTodos, ...openTodos];
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: "text", text: serializeTodoListForAgent(listedTodos) }],
						details: { action: "list", todos: listedTodos, currentSessionId },
					};
				}

				case "list-all": {
					const todos = await listTodos(todosDir);
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: "text", text: serializeTodoListForAgent(todos) }],
						details: { action: "list-all", todos, currentSessionId },
					};
				}

				case "get": {
					const resolved = resolveTodoId(todosDir, params.id);
					if ("kind" in resolved) return toolErrorResult(todosDir, "get", resolved);
					const { filePath, id } = resolved;
					const todo = await ensureTodoExists(filePath, id);
					if (!todo) {
						return toolErrorResult(todosDir, "get", { kind: "not_found", id: params.id });
					}
					return {
						content: [{ type: "text", text: serializeTodoForAgent(todo) }],
						details: { action: "get", todo },
					};
				}

				case "create": {
					if (!params.title) {
						return toolErrorResult(todosDir, "create", { kind: "invalid_params", detail: "title required" });
					}
					await ensureTodosDir(todosDir);
					const id = await generateTodoId(todosDir);
					const filePath = getTodoPath(todosDir, id);
					const todo: TodoRecord = {
						id,
						title: params.title,
						tags: params.tags ?? [],
						status: params.status ?? "open",
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						closed_at: params.status && isTodoClosed(params.status) ? new Date().toISOString() : undefined,
						body: params.body ?? "",
					};

					const result = await withTodoLock(todosDir, id, ctx, async () => {
						await writeTodoFile(filePath, todo);
						return todo;
					});

					if (typeof result === "object" && "kind" in result) {
						return toolErrorResult(todosDir, "create", result);
					}

					return {
						content: [{ type: "text", text: serializeTodoSummary(todo) }],
						details: { action: "create", todo },
					};
				}

				case "update": {
					const resolved = resolveTodoId(todosDir, params.id);
					if ("kind" in resolved) return toolErrorResult(todosDir, "update", resolved);
					const { id: normalizedId, filePath } = resolved;
					const { out: result, promo: siblingPromo } = await closeWithPromotion(todosDir, ctx, normalizedId, () =>
						withTodoLock(todosDir, normalizedId, ctx, async () => {
							const existing = await ensureTodoExists(filePath, normalizedId);
							if (!existing) return { kind: "not_found", id: params.id };

							existing.id = normalizedId;
							if (params.title !== undefined) existing.title = params.title;
							if (params.status !== undefined) existing.status = params.status;
							if (params.tags !== undefined) existing.tags = params.tags;
							if (params.body !== undefined) existing.body = params.body;
							if (!existing.created_at) existing.created_at = new Date().toISOString();
							clearAssignmentIfClosed(existing);
							touchTodo(existing);

							await writeTodoFile(filePath, existing);
							return existing;
						}),
					);

					if (typeof result === "object" && "kind" in result) {
						return toolErrorResult(todosDir, "update", result);
					}

					const updatedTodo = result as TodoRecord;
					const promo = params.status !== undefined && isTodoClosed(updatedTodo.status) ? siblingPromo : null;
					const text = serializeTodoSummary(updatedTodo) + promotionNote(promo);
					return {
						content: [{ type: "text", text }],
						details: { action: "update", todo: updatedTodo, ...(promo ? { promoted: promo } : {}) },
					};
				}

				case "append": {
					const resolved = resolveTodoId(todosDir, params.id);
					if ("kind" in resolved) return toolErrorResult(todosDir, "append", resolved);
					const { id: normalizedId, filePath } = resolved;
					const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
						const existing = await ensureTodoExists(filePath, normalizedId);
						if (!existing) return { kind: "not_found", id: params.id };
						if (!params.body || !params.body.trim()) {
							return existing;
						}
						const updated = await appendTodoBody(filePath, existing, params.body);
						return updated;
					});

					if (typeof result === "object" && "kind" in result) {
						return toolErrorResult(todosDir, "append", result);
					}

					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoSummary(updatedTodo) }],
						details: { action: "append", todo: updatedTodo },
					};
				}

				case "claim": {
					if (!params.id) return toolErrorResult(todosDir, "claim", { kind: "id_required" });
					const result = await claimTodoAssignment(todosDir, params.id, ctx, Boolean(params.force));
					if (typeof result === "object" && "kind" in result) {
						return toolErrorResult(todosDir, "claim", result);
					}
					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoSummary(updatedTodo) }],
						details: { action: "claim", todo: updatedTodo },
					};
				}

				case "release": {
					if (!params.id) return toolErrorResult(todosDir, "release", { kind: "id_required" });
					const result = await releaseTodoAssignment(todosDir, params.id, ctx, Boolean(params.force));
					if (typeof result === "object" && "kind" in result) {
						return toolErrorResult(todosDir, "release", result);
					}
					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoSummary(updatedTodo) }],
						details: { action: "release", todo: updatedTodo },
					};
				}

				case "delete": {
					const resolved = resolveTodoId(todosDir, params.id);
					if ("kind" in resolved) return toolErrorResult(todosDir, "delete", resolved);
					const result = await deleteTodo(todosDir, resolved.id, ctx);
					if (typeof result === "object" && "kind" in result) {
						return toolErrorResult(todosDir, "delete", result);
					}

					return {
						content: [{ type: "text", text: serializeTodoSummary(result as TodoRecord) }],
						details: { action: "delete", todo: result as TodoRecord },
					};
				}
			}
		},


		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "";
			const id = typeof args.id === "string" ? args.id : "";
			const normalizedId = id ? normalizeTodoId(id) : "";
			const title = typeof args.title === "string" ? args.title : "";
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
			if (normalizedId) {
				text += " " + theme.fg("accent", formatTodoId(normalizedId));
			}
			if (title) {
				text += " " + theme.fg("dim", `"${title}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as TodoToolDetails | undefined;
			if (isPartial) {
				return new Text(theme.fg("warning", "Processing..."), 0, 0);
			}
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${tuiTodoErrorMessage(details.error)}`), 0, 0);
			}

			if (details.action === "list" || details.action === "list-all") {
				let text = renderTodoList(theme, details.todos, expanded, details.currentSessionId);
				if (!expanded) {
					const { closedTodos } = splitTodosByAssignment(details.todos);
					if (closedTodos.length) {
						text = appendExpandHint(theme, text);
					}
				}
				return new Text(text, 0, 0);
			}

			if (!("todo" in details)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			let text = renderTodoDetail(theme, details.todo, expanded);
			const actionLabel =
				details.action === "create"
					? "Created"
					: details.action === "update"
						? "Updated"
						: details.action === "append"
							? "Appended to"
							: details.action === "delete"
								? "Deleted"
								: details.action === "claim"
									? "Claimed"
									: details.action === "release"
										? "Released"
										: null;
			if (actionLabel) {
				const lines = text.split("\n");
				lines[0] = theme.fg("success", "✓ ") + theme.fg("muted", `${actionLabel} `) + lines[0];
				text = lines.join("\n");
			}
			if (!expanded) {
				text = appendExpandHint(theme, text);
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "List todos from .pi/todos",
		handler: async (args, ctx) => {
			const todosDir = getTodosDir(ctx.cwd);
			const todos = await listTodos(todosDir);
			const currentSessionId = ctx.sessionManager.getSessionId();
			const searchTerm = (args ?? "").trim();

			if (!ctx.hasUI) {
				const text = formatTodoList(todos);
				console.log(text);
				return;
			}

			let nextPrompt: string | null = null;
			let rootTui: TUI | null = null;
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				rootTui = tui;
				let selector: TodoSelectorComponent | null = null;
				let actionMenu: TodoActionMenuComponent | null = null;
				let deleteConfirm: TodoDeleteConfirmComponent | null = null;
				let activeComponent:
					| {
							render: (width: number) => string[];
							invalidate: () => void;
							handleInput?: (data: string) => void;
							focused?: boolean;
						}
					| null = null;
				let wrapperFocused = false;

				const setActiveComponent = (
					component:
						| {
								render: (width: number) => string[];
								invalidate: () => void;
								handleInput?: (data: string) => void;
								focused?: boolean;
							}
						| null,
				) => {
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = false;
					}
					activeComponent = component;
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = wrapperFocused;
					}
					tui.requestRender();
				};

				const copyTodoPathToClipboard = (todoId: string) => {
					const filePath = getTodoPath(todosDir, todoId);
					const absolutePath = path.resolve(filePath);
					try {
						copyToClipboard(absolutePath);
						ctx.ui.notify(`Copied ${absolutePath} to clipboard`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(message, "error");
					}
				};

				const copyTodoTextToClipboard = (record: TodoRecord) => {
					const title = record.title || "(untitled)";
					const body = record.body?.trim() || "";
					const text = body ? `# ${title}\n\n${body}` : `# ${title}`;
					try {
						copyToClipboard(text);
						ctx.ui.notify("Copied todo text to clipboard", "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(message, "error");
					}
				};

				const resolveTodoRecord = async (todo: TodoFrontMatter): Promise<TodoRecord | null> => {
					const filePath = getTodoPath(todosDir, todo.id);
					const record = await ensureTodoExists(filePath, todo.id);
					if (!record) {
						ctx.ui.notify(`Todo ${formatTodoId(todo.id)} not found`, "error");
						return null;
					}
					return record;
				};

				const openTodoOverlay = async (record: TodoRecord): Promise<TodoOverlayAction> => {
					const action = await ctx.ui.custom<TodoOverlayAction>(
						(overlayTui, overlayTheme, overlayKeybindings, overlayDone) =>
							new TodoDetailOverlayComponent(
								overlayTui,
								overlayTheme,
								overlayKeybindings,
								record,
								overlayDone,
							),
						{
							overlay: true,
							overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
						},
					);

					return action ?? "back";
				};

				const applyTodoAction = async (
					record: TodoRecord,
					action: TodoMenuAction,
				): Promise<"stay" | "exit"> => {
					if (action === "refine") {
						const title = record.title || "(untitled)";
						nextPrompt = buildRefinePrompt(record.id, title);
						done();
						return "exit";
					}
					if (action === "work") {
						const title = record.title || "(untitled)";
						nextPrompt = `work on todo ${formatTodoId(record.id)} "${title}"`;
						done();
						return "exit";
					}
					if (action === "view") {
						return "stay";
					}
					if (action === "copyPath") {
						copyTodoPathToClipboard(record.id);
						return "stay";
					}
					if (action === "copyText") {
						copyTodoTextToClipboard(record);
						return "stay";
					}

					if (action === "release") {
						const result = await releaseTodoAssignment(todosDir, record.id, ctx, true);
						if ("error" in result) {
							ctx.ui.notify(tuiTodoErrorMessage(result.error), "error");
							return "stay";
						}
						const updatedTodos = await listTodos(todosDir);
						selector?.setTodos(updatedTodos);
						ctx.ui.notify(`Released todo ${formatTodoId(record.id)}`, "info");
						return "stay";
					}

					if (action === "delete") {
						const result = await deleteTodo(todosDir, record.id, ctx);
						if ("error" in result) {
							ctx.ui.notify(tuiTodoErrorMessage(result.error), "error");
							return "stay";
						}
						const updatedTodos = await listTodos(todosDir);
						selector?.setTodos(updatedTodos);
						ctx.ui.notify(`Deleted todo ${formatTodoId(record.id)}`, "info");
						return "stay";
					}

					const nextStatus = action === "close" ? "closed" : "open";
					const result = await updateTodoStatus(todosDir, record.id, nextStatus, ctx);
					if ("error" in result) {
						ctx.ui.notify(tuiTodoErrorMessage(result.error), "error");
						return "stay";
					}

					const updatedTodos = await listTodos(todosDir);
					selector?.setTodos(updatedTodos);
					ctx.ui.notify(
						`${action === "close" ? "Closed" : "Reopened"} todo ${formatTodoId(record.id)}`,
						"info",
					);
					return "stay";
				};

				const handleActionSelection = async (record: TodoRecord, action: TodoMenuAction) => {
					if (action === "view") {
						const overlayAction = await openTodoOverlay(record);
						if (overlayAction === "work") {
							await applyTodoAction(record, "work");
							return;
						}
						if (actionMenu) {
							setActiveComponent(actionMenu);
						}
						return;
					}

					if (action === "delete") {
						const message = `Delete todo ${formatTodoId(record.id)}? This cannot be undone.`;
						deleteConfirm = new TodoDeleteConfirmComponent(theme, message, (confirmed) => {
							if (!confirmed) {
								setActiveComponent(actionMenu);
								return;
							}
							void (async () => {
								await applyTodoAction(record, "delete");
								setActiveComponent(selector);
							})();
						});
						setActiveComponent(deleteConfirm);
						return;
					}

					const result = await applyTodoAction(record, action);
					if (result === "stay") {
						setActiveComponent(selector);
					}
				};

				const showActionMenu = async (todo: TodoFrontMatter | TodoRecord) => {
					const record = "body" in todo ? todo : await resolveTodoRecord(todo);
					if (!record) return;
					actionMenu = new TodoActionMenuComponent(
						theme,
						record,
						(action) => {
							void handleActionSelection(record, action);
						},
						() => {
							setActiveComponent(selector);
						},
					);
					setActiveComponent(actionMenu);
				};

				const handleSelect = async (todo: TodoFrontMatter) => {
					await showActionMenu(todo);
				};

				selector = new TodoSelectorComponent(
					tui,
					theme,
					keybindings,
					todos,
					(todo) => {
						void handleSelect(todo);
					},
					() => done(),
					searchTerm || undefined,
					currentSessionId,
					(todo, action) => {
						const title = todo.title || "(untitled)";
						nextPrompt =
							action === "refine"
								? buildRefinePrompt(todo.id, title)
								: `work on todo ${formatTodoId(todo.id)} "${title}"`;
						done();
					},
				);

				setActiveComponent(selector);

				const rootComponent = {
					get focused() {
						return wrapperFocused;
					},
					set focused(value: boolean) {
						wrapperFocused = value;
						if (activeComponent && "focused" in activeComponent) {
							activeComponent.focused = value;
						}
					},
					render(width: number) {
						return activeComponent ? activeComponent.render(width) : [];
					},
					invalidate() {
						activeComponent?.invalidate();
					},
					handleInput(data: string) {
						activeComponent?.handleInput?.(data);
					},
				};

				return rootComponent;
			});

			if (nextPrompt) {
				ctx.ui.setEditorText(nextPrompt);
				rootTui?.requestRender();
			}
		},
	});

}
