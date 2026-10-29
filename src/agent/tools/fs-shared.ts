import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AUTH_FILE, ROOT } from "../../../config.ts";



/** Resolve a tool path argument: absolute stays, relative/absent → home. */
export function resolveSourcePath(p?: string): string {
	if (!p) return os.homedir();
	return path.isAbsolute(p) ? p : path.join(os.homedir(), p);
}

/** THE SECRET-FILE GUARD: the learner-file tools (read / ls / find / grep / the pdf reader) never open the app's own secrets — enforced here in code */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function normalizePath(p: string): string {
	const resolved = path.resolve(p);
	return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

/** Could this basename be a secret at all? */
function hasSecretName(p: string): boolean {
	const name = path.basename(p).toLowerCase();
	return (
		name === ".env" ||
		name.startsWith(".env.") ||
		name === "auth.json" ||
		name.startsWith(".auth.json.tmp") ||
		name.includes("-credentials.json") ||
		name === path.basename(AUTH_FILE).toLowerCase()
	);
}

function isSecretPath(p: string): boolean {
	if (normalizePath(p) === normalizePath(AUTH_FILE)) return true;
	const name = path.basename(p).toLowerCase();
	if (name === ".env" || name.startsWith(".env.")) return true;
	const secretDirs = [path.dirname(AUTH_FILE), ROOT].map(normalizePath);
	return secretDirs.includes(normalizePath(path.dirname(p))) && hasSecretName(p);
}

/** True when `p` (or what it links to) is a protected secret file. */
export async function isProtectedPath(p: string): Promise<boolean> {
	if (isSecretPath(p)) return true;
	try {
		const real = await fs.realpath(p);
		return real !== path.resolve(p) && isSecretPath(real);
	} catch {
		return false; // missing path: nothing to protect; the caller's own error surfaces
	}
}









