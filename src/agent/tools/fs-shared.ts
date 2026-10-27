import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AUTH_FILE, ROOT } from "../../../config.ts";

/**
 * Shared plumbing for the learner-filesystem tools (ls / find / grep) —
 * sources v1 (2026-09-19): the agent locates and reads the learner's files
 * itself, so paths need no UI affordance (user decision: no attachments —
 * the learner references files in messages; the agent finds them).
 *
 * Safety posture (user-locked): READ-ONLY by construction — no shell-out,
 * no user-controlled process args, no mutation APIs anywhere here. The one
 * deliberate scope widening vs pi: relative paths and default roots resolve
 * against the LEARNER'S HOME, not a project cwd — the harness has no
 * meaningful working directory, and "find my notes" should just work.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/{ls,find,grep}.js): the
 * schemas, descriptions, output formats, and truncation notices are copied
 * verbatim except where semantics differ (home default, no .gitignore —
 * replaced by hard noise exclusions).
 */

/** 50KB — pi's DEFAULT_MAX_BYTES, the output ceiling for every fs tool. */
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** pi's grep line-truncation length (GREP_MAX_LINE_LENGTH). */
export const GREP_MAX_LINE_LENGTH = 500;
/** Wall-clock budget for tree walks (find/grep over a whole home dir). */
export const WALK_TIMEOUT_MS = 10_000;

/**
 * Directory names never entered during walks. node_modules/.git mirror pi's
 * fd/rg defaults; Library/.Trash are the home-root noise the user approved
 * (2026-09-19) — caches, app support, and the trash live under them.
 * Explicit paths (ls/read of ~/Library/…) are NOT filtered — only walks.
 */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "Library", ".Trash"]);

/** Resolve a tool path argument: absolute stays, relative/absent → home.
 *  (pi resolves against the project cwd; the harness's "project" is the
 *  learner's life, so the home directory is the anchor.) */
export function resolveSourcePath(p?: string): string {
	if (!p) return os.homedir();
	return path.isAbsolute(p) ? p : path.join(os.homedir(), p);
}

/**
 * THE SECRET-FILE GUARD (key hardening, 2026-10-27): the learner-file tools
 * (read / ls / find / grep / the pdf reader) never open the app's own
 * secrets — enforced here in code, not asked of the model in a prompt, so
 * a prompt-injected agent still cannot reach them. Protected:
 *   - the BYOK key store (AUTH_FILE, wherever LH_AUTH_FILE points it),
 *   - its siblings in the key store's directory and the repo root: any
 *     auth.json, its atomic-write temps, and the subscription login files
 *     (`<provider>-credentials.json*`),
 *   - any `.env` / `.env.*` file anywhere (dev secrets).
 * Symlinks/junctions are resolved: a link to a secret is the secret.
 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function normalizePath(p: string): string {
	const resolved = path.resolve(p);
	return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

/** Could this basename be a secret at all? (A path-only symlink keeps the
 *  basename, so walks — which never follow file symlinks — prefilter on it.) */
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

/** Throws the model-visible refusal for a protected path. */
export async function assertNotProtected(p: string): Promise<void> {
	if (await isProtectedPath(p)) {
		throw new Error(`Access denied: ${p} is a protected secret file (API keys / credentials).`);
	}
}

/** pi's formatSize idiom (50KB prints as "50.0KB"). */
export function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Cap output to MAX_OUTPUT_BYTES on whole lines, pi's truncateHead idiom. */
export function capOutput(lines: string[]): { content: string; truncated: boolean } {
	const out: string[] = [];
	for (const line of lines) {
		const candidate = [...out, line].join("\n");
		if (Buffer.byteLength(candidate, "utf-8") > MAX_OUTPUT_BYTES) {
			return { content: out.join("\n"), truncated: true };
		}
		out.push(line);
	}
	return { content: out.join("\n"), truncated: false };
}

/** Expand top-level brace alternatives: '*.{ts,tsx}' → ['*.ts', '*.tsx'].
 *  Nested braces are out of scope (pi's fd handles them; models rarely
 *  emit them — a non-expanding literal match is the graceful fallback). */
export function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const close = pattern.indexOf("}", open);
	if (close === -1) return [pattern];
	const before = pattern.slice(0, open);
	const after = pattern.slice(close + 1);
	const alts: string[] = [];
	for (const alt of pattern.slice(open + 1, close).split(",")) {
		alts.push(...expandBraces(before + alt + after));
	}
	return alts;
}

/** Glob → anchored RegExp. '*' stays within a segment, '**' crosses '/',
 *  '?' is one char, everything else literal. */
export function globToRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += "[\\s\\S]*";
				i++;
				if (glob[i + 1] === "/") i++; // '**/' also eats the slash
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/**
 * pi/fd's matching rule: a pattern with no slash matches against the
 * BASENAME at any depth; one with a slash matches the relative path, with
 * an implied leading "**-slash" prefix unless it is itself anchored (see
 * the code below — the literal sequence cannot appear in this comment
 * because it terminates block comments).
 */
export function matchGlob(relativePath: string, pattern: string): boolean {
	const posix = relativePath.split(path.sep).join("/");
	const basename = posix.split("/").pop() ?? posix;
	for (const alt of expandBraces(pattern)) {
		if (!alt.includes("/")) {
			if (globToRegex(alt).test(basename)) return true;
		} else {
			let effective = alt;
			if (!effective.startsWith("/") && !effective.startsWith("**/") && effective !== "**") {
				effective = `**/${effective}`;
			}
			if (effective.startsWith("/")) effective = effective.slice(1);
			if (globToRegex(effective).test(posix)) return true;
		}
	}
	return false;
}

/**
 * Depth-first walk under `root`, never entering EXCLUDED_DIR_NAMES.
 * `visit` receives absolute file paths; returning true STOPS the walk
 * (find's result limit). The deadline bounds a home-dir walk to
 * WALK_TIMEOUT_MS — partial results are the graceful degradation.
 */
export async function walkFiles(
	root: string,
	visit: (filePath: string) => boolean | Promise<boolean>,
	signal?: AbortSignal,
): Promise<{ timedOut: boolean; aborted: boolean }> {
	const deadline = Date.now() + WALK_TIMEOUT_MS;
	let timedOut = false;
	let aborted = false;
	if (signal?.aborted) return { timedOut: false, aborted: true };

	const walkDir = async (dir: string): Promise<boolean> => {
		if (Date.now() > deadline) {
			timedOut = true;
			return true; // stop
		}
		if (signal?.aborted) {
			aborted = true;
			return true; // stop — abort yields partial results, not a throw
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return false; // unreadable dir (permissions): skip, keep walking
		}
		for (const entry of entries) {
			if (Date.now() > deadline) {
				timedOut = true;
				return true;
			}
			if (signal?.aborted) {
				aborted = true;
				return true;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
				if (await walkDir(full)) return true;
			} else if (entry.isFile()) {
				if (hasSecretName(full) && (await isProtectedPath(full))) continue; // secrets are invisible to walks
				if (await visit(full)) return true;
			}
			// symlinks/other: not followed (pi's fd doesn't follow either)
		}
		return false;
	};

	await walkDir(root);
	return { timedOut, aborted };
}

/** True if the first 8KB chunk contains a NUL byte — pi/rg's binary skip. */
export async function isBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buf, 0, 8192, 0);
		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

/** pi's GREP_MAX_LINE_LENGTH line truncation (no mid-word care, hard cap). */
export function truncateGrepLine(line: string): { text: string; wasTruncated: boolean } {
	if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}… [truncated]`, wasTruncated: true };
}
