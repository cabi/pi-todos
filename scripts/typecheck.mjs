// Type-check todos.ts against the installed pi release's type definitions
// (strict, no emit). The test harness only transpiles (--noCheck); this script
// is the guard against API drift in the extension surfaces we use.
// Run: npm run typecheck   (override with TSC_BIN / TODOS_TS / PI_NM)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { piNodeModules } from "../test/pi-release.mjs";

const TSC = process.env.TSC_BIN ?? "tsc";
const PI_NM = process.env.PI_NM ?? piNodeModules();
const SRC = process.env.TODOS_TS ?? new URL("../todos.ts", import.meta.url).pathname;

const work = fs.mkdtempSync("/tmp/todos-typecheck-");
fs.symlinkSync(PI_NM, path.join(work, "node_modules"), "dir");
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ type: "module" }));
fs.copyFileSync(SRC, path.join(work, "todos.ts"));

try {
	execSync(
		`${TSC} ${path.join(work, "todos.ts")} --noEmit --target es2022 --module esnext --moduleResolution bundler --strict --skipLibCheck`,
		{ stdio: "inherit", cwd: work },
	);
	console.log(`typecheck: OK — ${SRC} against ${PI_NM}`);
} catch {
	process.exitCode = 1;
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
