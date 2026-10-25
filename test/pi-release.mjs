// Shared harness helper: resolve the newest installed pi release's node_modules,
// so tests and typecheck compile against the same peer deps pi actually loads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function piNodeModules() {
	const releasesDir = path.join(os.homedir(), ".pi/agent/install/releases");
	const latest = fs
		.readdirSync(releasesDir)
		.filter((d) => /^\d+\.\d+\.\d+$/.test(d))
		.sort((a, b) => {
			const [a0, a1, a2] = a.split(".").map(Number);
			const [b0, b1, b2] = b.split(".").map(Number);
			return a0 - b0 || a1 - b1 || a2 - b2;
		})
		.pop();
	return path.join(releasesDir, latest ?? "1.4.0", "node_modules");
}
