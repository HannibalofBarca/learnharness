/** The curated auth-key catalog + shape rules. */

/** One curated key entry. `id` is the env-var/file key name. */
export interface AuthKeyInfo {
	id: string;
	/** Human label for the settings page. */
	label: string;
	/** One-sentence what-is-this-for. */
	description: string;
	/** Where the user gets a key (opens in the real browser via the shell). */
	docsUrl: string;
}

export const AUTH_KEYS: readonly AuthKeyInfo[] = [
	{
		id: "DEEPGRAM_API_KEY",
		label: "Deepgram",
		description: "Speech-to-text key for dictation — needs ≥ Member permission in the Deepgram console to mint tokens.",
		docsUrl: "https://console.deepgram.com/",
	},
] as const;

const AUTH_KEY_IDS: ReadonlySet<string> = new Set(AUTH_KEYS.map((k) => k.id));

export function isKnownAuthKey(id: string): boolean {
	return AUTH_KEY_IDS.has(id);
}

/** One model-provider key row for the settings page's dropdown: which pi-ai provider, the env var its key rides in */
interface AuthProviderInfo {
	id: string;
	envVar: string;
	label: string;
}

/** THE MODEL-PROVIDER KEY TABLE — empty under the Claude Code bridge (docs/claude-code-bridge.md): the tutor's model is the learner's own Claude Code */
export const AUTH_PROVIDER_KEYS: readonly AuthProviderInfo[] = [];

/** Every distinct env var a model-provider key rides in (the write side's writability check — see isProviderEnvVar below */
export const AUTH_PROVIDER_ENV_VARS: ReadonlySet<string> = new Set(AUTH_PROVIDER_KEYS.map((p) => p.envVar));

/** Is this env-var name the key of SOME pi-ai model provider? */
export function isProviderEnvVar(envVar: string): boolean {
	return AUTH_PROVIDER_ENV_VARS.has(envVar);
}

/** Shape-check result: ok, or a 400-ready message naming the expectation. */
type KeyShapeResult = { ok: true } | { ok: false; error: string };

/** The write-side shape gate. */
export function validateKeyShape(id: string, rawValue: string): KeyShapeResult {
	const value = rawValue.trim();
	const nonEmpty = (min: number) =>
		value.length >= min && !/\s/.test(value)
			? { ok: true as const }
			: { ok: false as const, error: `${id} must be at least ${min} characters with no whitespace` };
	switch (id) {
		case "TAVILY_API_KEY":
			return value.startsWith("tvly-")
				? nonEmpty(20)
				: { ok: false, error: `${id} must start with "tvly-" (Tavily's key format)` };
		case "BRAVE_API_KEY":
			// No public format — a length floor + paste hygiene only.
			return nonEmpty(20);
		case "DEEPGRAM_API_KEY":
			// No public format — the length floor only catches truncated pastes.
			return nonEmpty(20);
		default:
			return { ok: false, error: `unknown key "${id}" (supported: ${[...AUTH_KEY_IDS].join(", ")})` };
	}
}

/** The generic truncation guard for MODEL-PROVIDER keys. */
export function genericProviderKeyGuard(id: string, rawValue: string): KeyShapeResult {
	const value = rawValue.trim();
	if (value.length >= 12 && !/\s/.test(value)) return { ok: true };
	return { ok: false, error: `${id} must be at least 12 characters with no whitespace` };
}

/** A masked key never leaves the server as plaintext. */
export function maskKey(value: string): string {
	const v = value.trim();
	if (v.length <= 4) return `…${v}`; // degenerate paste — still never the whole value
	return `…${v.slice(-4)}`;
}

/** One key's status row for the GET view (never carries plaintext). */
export interface AuthKeyStatus {
	id: string;
	/** Catalog metadata when the key is curated; null for unknown-file-var entries (preserved + surfaced, but no curated form to edit through). */
	info: AuthKeyInfo | null;
	/** A key is present when EITHER the environment or the file has it. */
	present: boolean;
	/** The masked tail + character count, e.g. "…ab12 (64 chars)". */
	masked: string | null;
	/** Where the live value comes from, given env-wins precedence. */
	source: "env" | "file" | "none";
	/** True when the file holds a value that the environment shadows — the settings page explains why a saved key is not the live one. */
	shadowedByEnv: boolean;
}
