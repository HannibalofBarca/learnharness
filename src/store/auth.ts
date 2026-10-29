/** The AuthStore adapter: the flat {VAR: value} auth.json map at config.AUTH_FILE — the SAME file the Electron app has always hand-edited. */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

/** Write the map atomically at mode 0600: a partial write must never leave a 0644 file (secrets) or a truncated JSON (looks like "no keys"). */
function writeMap(map: Record<string, string>): void {
	const dir = path.dirname(AUTH_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.auth.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, AUTH_FILE);
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
};
