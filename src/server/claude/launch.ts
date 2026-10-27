/**
 * The pre-wired Claude Code launch (docs/claude-code-bridge.md §Launch):
 * per chat, the server writes the method prompt, the session settings and
 * the MCP config under data/claude/<chatId>/ (the data dir is denied to the
 * tutor's Read, and these files carry the bridge token), and returns the
 * argv the desktop shell spawns in its terminal.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_FILE, PATHS } from "../../../config.ts";
import { effectivePromptSegments } from "../../agent/prompt-segments.ts";
import { effectiveSettings, stores } from "../stores.ts";
import { bridgeToken } from "./token.ts";
import { listTools } from "./tools.ts";

const CLAUDE_DIR = path.join(PATHS.data, "claude");
const SESSION_MAP = path.join(CLAUDE_DIR, "sessions.json");
/** Claude Code keys its transcripts by working directory: one stable,
 *  empty folder for every tutor session (no CLAUDE.md, no project files). */
export const TUTOR_CWD = path.join(os.tmpdir(), "learnharness-tutor");

const BRIDGE_PREAMBLE = `# You are the LearnHarness tutor

You are running inside LearnHarness, a learning app. The learner does NOT read this terminal: they read and answer in the LearnHarness window. Everything they should see goes through the LearnHarness tools.

How a session works:
- Every lesson text, explanation or reply to the learner goes through \`send_to_user\` (Markdown and LaTeX render there). Terminal text is invisible to the learner — keep it to a word or two.
- Every reply ENDS with a blocking tool: a question tool (\`probe\`/\`recall\` while probing, \`quiz\`/\`explain\` while teaching, \`ask_user_question\` any time), \`problem\` in practice, or \`wait_for_learner\`. Never just stop; the learner's next input arrives as that tool's result.
- At the start, and after your context is compacted, call \`resume_session\` to read this session's state. The learner's first message (their topic) is in it or arrives through \`wait_for_learner\`. Name a new session with \`set_title\`.
- A teaching session has two phases: you start as the PROBER (the probing doctrine below) and conclude with \`probe_done\`; from then on you are the TEACHER (planning with \`plan_init\`, then teaching). Tools of the other phase are refused.
- Where the method below mentions file tools (find, ls, grep, read), use your own Glob, Grep and Read. Where it mentions dispatching research, pdf, demo or visual jobs, do that work yourself (WebSearch/WebFetch/Read) and hand the result to the learner with the LearnHarness delivery tools when they are listed, otherwise with \`send_to_user\`.
- Never read LearnHarness's own data folder or any key or credential file.

The method follows. It is the authority on how to teach.`;

function segmentText(s: { enabled: boolean; overrideText: string | null; sourceText: string }): string {
	return (s.enabled ? s.overrideText! : s.sourceText).trim();
}

/** The whole method for one session kind, as one system-prompt appendix. */
export function bridgePrompt(kind: "teach" | "practice"): string {
	const switches = effectiveSettings().agent.prompts ?? {};
	if (kind === "practice") {
		const segments = effectivePromptSegments("practice", switches).map(segmentText).filter(Boolean);
		return [BRIDGE_PREAMBLE, ...segments].join("\n\n---\n\n");
	}
	const prober = effectivePromptSegments("prober", switches);
	const teacher = effectivePromptSegments("teacher", switches);
	const shared = prober.filter((s) => s.shared).map(segmentText).filter(Boolean);
	const own = (list: typeof prober) => list.filter((s) => !s.shared).map(segmentText).filter(Boolean).join("\n\n");
	return [
		BRIDGE_PREAMBLE,
		...shared,
		`# Phase 1 — PROBING (until you call probe_done)\n\n${own(prober)}`,
		`# Phase 2 — TEACHING (after probe_done)\n\n${own(teacher)}`,
	].join("\n\n---\n\n");
}

function readSessionMap(): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(SESSION_MAP, "utf-8")) as Record<string, string>;
	} catch {
		return {};
	}
}

/** Claude-style absolute path for permission rules: //c/Users/... */
function rulePath(p: string): string {
	const posix = path.resolve(p).replace(/\\/g, "/");
	return /^[A-Za-z]:\//.test(posix) ? `//${posix[0]!.toLowerCase()}${posix.slice(2)}` : `/${posix}`;
}

export interface ClaudeLaunch {
	cwd: string;
	command: string;
	/** Resume the chat's Claude conversation (absent on first launch). */
	resumeArgs?: string[];
	/** Start a new conversation (first launch, or when resume fails). */
	freshArgs: string[];
}

/** Write the per-chat launch files and return the argv. `origin` is the
 *  server's own loopback origin (the MCP and hook URLs). */
export function claudeLaunch(chatId: string, origin: string): ClaudeLaunch | null {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null;
	const dir = path.join(CLAUDE_DIR, chatId);
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(TUTOR_CWD, { recursive: true });
	const token = bridgeToken();

	const promptFile = path.join(dir, "method.md");
	fs.writeFileSync(promptFile, bridgePrompt(record.kind === "practice" ? "practice" : "teach"), "utf-8");

	const mcpFile = path.join(dir, "mcp.json");
	const mcp = {
		mcpServers: {
			learnharness: {
				type: "http",
				url: `${origin}/api/mcp?chat=${encodeURIComponent(chatId)}`,
				headers: { Authorization: `Bearer ${token}` },
			},
		},
	};
	fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, "\t"), { mode: 0o600 });

	const hookUrl = `${origin}/api/claude/hook?chat=${encodeURIComponent(chatId)}`;
	const settingsFile = path.join(dir, "settings.json");
	const settings = {
		autoMemoryEnabled: false,
		disableClaudeAiConnectors: true,
		permissions: {
			deny: [
				`Read(${rulePath(PATHS.data)}/**)`,
				`Read(${rulePath(AUTH_FILE)})`,
				"Read(**/.env)",
				"Read(**/.env.*)",
				"Read(**/*-credentials.json*)",
				"Read(**/auth.json)",
			],
		},
		hooks: {
			Stop: [
				{
					hooks: [
						{
							type: "command",
							command: `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary @- "${hookUrl}"`,
						},
					],
				},
			],
		},
	};
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, "\t"), { mode: 0o600 });

	const lh = listTools(chatId).map((t) => `mcp__learnharness__${t.name}`);
	const tools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", ...lh];
	const common = [
		"--restricted",
		"--strict-mcp-config",
		"--mcp-config",
		mcpFile,
		"--settings",
		settingsFile,
		"--tools",
		tools.join(","),
		"--allowedTools",
		tools.join(","),
		"--append-system-prompt-file",
		promptFile,
		"--add-dir",
		os.homedir(),
	];
	for (const drive of extraDrives()) common.push("--add-dir", drive);

	const map = readSessionMap();
	const existing = map[chatId];
	const fresh = randomUUID();
	map[chatId] = existing ?? fresh;
	if (!existing) fs.writeFileSync(SESSION_MAP, JSON.stringify(map, null, "\t"), "utf-8");
	const kickoff = record.messages.length > 0
		? "Begin: call resume_session, then continue the session in the LearnHarness window."
		: "Begin: call wait_for_learner to receive the learner's topic.";
	return {
		cwd: TUTOR_CWD,
		command: "claude",
		...(existing ? { resumeArgs: [...common, "--resume", existing, "The LearnHarness window reopened this session. Call resume_session, then continue."] } : {}),
		freshArgs: [...common, "--session-id", existing ? randomUUID() : fresh, kickoff],
	};
}

/** Remember the conversation a fresh-after-failed-resume launch created. */
export function rememberClaudeSession(chatId: string, sessionId: string): void {
	const map = readSessionMap();
	map[chatId] = sessionId;
	fs.mkdirSync(CLAUDE_DIR, { recursive: true });
	fs.writeFileSync(SESSION_MAP, JSON.stringify(map, null, "\t"), "utf-8");
}

/** Windows drive roots besides the home drive, so notes on any local drive
 *  are readable (Read stays denied for the data dir and secrets). */
function extraDrives(): string[] {
	if (process.platform !== "win32") return [];
	const home = path.parse(os.homedir()).root.toUpperCase();
	const drives: string[] = [];
	for (const letter of "CDEFGHIJ") {
		const root = `${letter}:\\`;
		if (root.toUpperCase() !== home && fs.existsSync(root)) drives.push(root);
	}
	drives.push(home);
	return drives;
}
