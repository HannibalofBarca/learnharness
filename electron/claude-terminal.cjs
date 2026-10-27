"use strict";

/**
 * The embedded tutor terminal (docs/claude-code-bridge.md): one pty per
 * session, owned by the main process. Opening a session's terminal asks the
 * app's own server for the pre-wired Claude Code launch and runs it in the
 * user's shell; when Claude exits the shell stays. Output is kept as a
 * bounded scrollback so a window that comes back to the session replays it.
 *
 * The renderer only ever sends keystrokes and sizes for a session id; it
 * never chooses what runs.
 */

const pty = require("node-pty");

const SCROLLBACK_BYTES = 256 * 1024;
const CHAT_ID = /^[A-Za-z0-9_-]+$/;

/** PowerShell single-quoted literal. */
function psQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/** POSIX single-quoted literal. */
function shQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The shell program + args that run the launch and then stay as a shell. */
function shellFor(launch, platform = process.platform) {
	if (platform === "win32") {
		const run = (args) => `& ${psQuote(launch.command)} ${args.map(psQuote).join(" ")}`;
		const missing = `if (-not (Get-Command ${psQuote(launch.command)} -ErrorAction SilentlyContinue)) { Write-Host 'Claude Code is not installed or not on PATH. Install it from https://claude.com/claude-code, then reopen this session.' -ForegroundColor Yellow }`;
		const body = launch.resumeArgs
			? `${run(launch.resumeArgs)}; if ($LASTEXITCODE -ne 0) { Write-Host 'Starting a new Claude conversation for this session...'; ${run(launch.freshArgs)} }`
			: run(launch.freshArgs);
		return { file: "powershell.exe", args: ["-NoLogo", "-NoExit", "-Command", `${missing} else { ${body} }`] };
	}
	const run = (args) => `${shQuote(launch.command)} ${args.map(shQuote).join(" ")}`;
	const body = launch.resumeArgs ? `${run(launch.resumeArgs)} || ${run(launch.freshArgs)}` : run(launch.freshArgs);
	const shell = process.env.SHELL || "/bin/bash";
	return { file: shell, args: ["-lc", `command -v ${shQuote(launch.command)} >/dev/null || echo 'Claude Code is not installed or not on PATH.'; ${body}; exec ${shQuote(shell)} -l`] };
}

/**
 * @param {object} deps
 * @param {() => string} deps.serverUrl  the app server's loopback origin
 * @param {() => string | null} deps.secret  the desktop API secret (null in dev)
 * @param {(chatId: string, data: string) => void} deps.onData
 * @param {(chatId: string, code: number) => void} deps.onExit
 * @param {(line: string) => void} [deps.log]
 */
function createTerminalHost(deps) {
	/** @type {Map<string, { proc: import("node-pty").IPty, scrollback: string }>} */
	const terms = new Map();

	async function fetchLaunch(chatId) {
		const headers = {};
		const secret = deps.secret();
		if (secret) headers["x-learnharness-desktop"] = secret;
		const res = await fetch(`${deps.serverUrl()}/api/claude/launch?chat=${encodeURIComponent(chatId)}`, { headers });
		if (!res.ok) throw new Error(`launch spec failed (${res.status})`);
		return res.json();
	}

	return {
		/** Start (or re-attach to) a session's terminal; returns the scrollback. */
		async open(chatId, cols, rows) {
			if (!CHAT_ID.test(chatId)) throw new Error("bad session id");
			const existing = terms.get(chatId);
			if (existing) {
				existing.proc.resize(Math.max(cols, 20), Math.max(rows, 5));
				return existing.scrollback;
			}
			const launch = await fetchLaunch(chatId);
			const { file, args } = shellFor(launch);
			const env = { ...process.env, FORCE_COLOR: "1" };
			delete env.ELECTRON_RUN_AS_NODE;
			const proc = pty.spawn(file, args, {
				name: "xterm-256color",
				cols: Math.max(cols, 20),
				rows: Math.max(rows, 5),
				cwd: launch.cwd,
				env,
			});
			const term = { proc, scrollback: "" };
			terms.set(chatId, term);
			proc.onData((data) => {
				term.scrollback = (term.scrollback + data).slice(-SCROLLBACK_BYTES);
				deps.onData(chatId, data);
			});
			proc.onExit(({ exitCode }) => {
				if (terms.get(chatId) === term) terms.delete(chatId);
				deps.onExit(chatId, exitCode);
			});
			deps.log?.(`terminal: opened for ${chatId}`);
			return "";
		},
		write(chatId, data) {
			terms.get(chatId)?.proc.write(String(data));
		},
		resize(chatId, cols, rows) {
			const term = terms.get(chatId);
			if (term && cols > 0 && rows > 0) term.proc.resize(cols, rows);
		},
		kill(chatId) {
			const term = terms.get(chatId);
			if (!term) return;
			terms.delete(chatId);
			try { term.proc.kill(); } catch { /* already gone */ }
		},
		killAll() {
			for (const chatId of [...terms.keys()]) this.kill(chatId);
		},
		has(chatId) {
			return terms.has(chatId);
		},
	};
}

module.exports = { createTerminalHost, shellFor, psQuote, shQuote };
