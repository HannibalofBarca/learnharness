/** The auth/keys composition: the server-side key manager behind GET/PUT/DELETE /api/keys. */

import {
	AUTH_KEYS,
	AUTH_PROVIDER_KEYS,
	AUTH_PROVIDER_ENV_VARS,
	type AuthKeyStatus,
	genericProviderKeyGuard,
	isKnownAuthKey,
	isProviderEnvVar,
	maskKey,
	validateKeyShape,
} from "../core/auth-keys.ts";
import { authStore } from "../store/auth.ts";

// The once-per-process boot record — globalThis anchor (HMR re-imports the module
interface AuthBoot {
	/** Vars that were in the REAL env at first init — env precedence's untouchable set. */
	realEnv: Set<string>;
	/** Vars WE put into process.env (the file's reflection) — deletable. */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

function boot(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

/** Is `id` a WRITABLE key name — curated catalog or model-provider env var (provider-keys interlude: PUT/DELETE accept both). */
export function isWritableAuthKey(id: string): boolean {
	return isKnownAuthKey(id) || isProviderEnvVar(id);
}

/** The settings page's provider dropdown: every pi-ai provider that takes a plain key ({id, envVar, label} — no-drift-pinned */
export function providerKeyList() {
	return [...AUTH_PROVIDER_KEYS].sort((a, b) => a.id.localeCompare(b.id));
}

/** The fresh-user switch: env keys are invisible app-wide — deleted from the process at boot, file keys only. */
function envKeysIgnored(): boolean {
	return process.env.LH_IGNORE_ENV_KEYS === "1";
}

/** The boot fill-gap — idempotent. */
function initAuthEnv(): void {
	const record = boot();
	const fileVars = authStore.authVars();
	const managed = new Set<string>([
		...Object.keys(fileVars),
		...AUTH_KEYS.map((k) => k.id),
		// Provider env vars are managed names too (provider-keys interlude):
		// an env-exported OPENAI_API_KEY with a file copy gets honest shadow
		// semantics, exactly like the curated vars.
		...AUTH_PROVIDER_KEYS.map((p) => p.envVar),
	]);
	if (envKeysIgnored()) {
		// THE FRESH-USER SWITCH: delete every managed env var (re-run on every call — a reintroduced var never resurrects).
		for (const name of managed) {
			delete process.env[name];
		}
	} else if (record.realEnv.size === 0 && record.fillGap.size === 0) {
		// First init in this process: what's already in the env is REAL env.
		for (const name of managed) {
			if (process.env[name] !== undefined) record.realEnv.add(name);
		}
	}
	for (const [name, value] of Object.entries(fileVars)) {
		if (!isManagedName(name)) continue;
		if (process.env[name] === undefined) {
			process.env[name] = value;
			record.fillGap.add(name);
		}
	}
}

/** Is this env-var name one the keys system manages (curated, provider, or held in the file)? */
function isManagedName(name: string): boolean {
	return isWritableAuthKey(name) || name in authStore.authVars();
}

/**
 * The pure status projection — exported for tests. `env` is the live
 * process env view; `realEnv` the boot snapshot (env precedence).
 */
function resolveKeyStatuses(
	fileVars: Record<string, string>,
	env: Record<string, string | undefined>,
	realEnv: ReadonlySet<string>,
	/** The model-provider env vars (provider-keys interlude): PRESENT ones join the status rows */
	providerEnvVars: ReadonlySet<string> = new Set(),
): AuthKeyStatus[] {
	const ids = new Set<string>([...AUTH_KEYS.map((k) => k.id), ...Object.keys(fileVars)]);
	for (const envVar of providerEnvVars) {
		if (env[envVar] !== undefined || fileVars[envVar] !== undefined) ids.add(envVar);
	}
	const rows: AuthKeyStatus[] = [];
	for (const id of ids) {
		const envValue = env[id];
		const fileValue = fileVars[id];
		const isRealEnv = realEnv.has(id);
		// Env wins: the live value is the env's when set (real or reflected — post fill-gap the file's values LIVE in env
		const live = envValue !== undefined ? envValue : fileValue;
		rows.push({
			id,
			info: AUTH_KEYS.find((k) => k.id === id) ?? null,
			present: live !== undefined,
			masked: live !== undefined ? `${maskKey(live)} (${live.trim().length} chars)` : null,
			source: isRealEnv ? "env" : live !== undefined ? "file" : "none",
			shadowedByEnv: isRealEnv && fileValue !== undefined && envValue !== fileValue,
		});
	}
	return rows;
}

/** The GET view: every curated key (present or not) + unknown file vars. */
export function keyStatuses(): AuthKeyStatus[] {
	return resolveKeyStatuses(authStore.authVars(), process.env, boot().realEnv, AUTH_PROVIDER_ENV_VARS);
}

/** The live value for one var, env-first (the env-wins rule) */
export function keyValue(id: string): string | undefined {
	// The fresh-user switch: ONLY the file store counts (belt-and- suspenders — the boot deletion already emptied the env
	if (envKeysIgnored()) return authStore.authVars()[id];
	return process.env[id] ?? authStore.authVars()[id];
}


/** Save one key (PUT). */
export function saveKey(id: string, value: string): { ok: true; status: AuthKeyStatus } | { ok: false; error: string } {
	const shape = isProviderEnvVar(id) ? genericProviderKeyGuard(id, value) : validateKeyShape(id, value);
	if (!shape.ok) return { ok: false, error: shape.error };
	const trimmed = value.trim();
	authStore.setAuthVar(id, trimmed);
	const record = boot();
	if (!record.realEnv.has(id)) {
		process.env[id] = trimmed;
		record.fillGap.add(id);
	}
	// validateKeyShape guarantees catalog membership, so the row exists.
	return { ok: true, status: keyStatuses().find((s) => s.id === id)! };
}

/** Remove one key (DELETE): gone from the file always; gone from the env only when the env copy was OURS (fill-gap) */
export function deleteKey(id: string): AuthKeyStatus {
	authStore.deleteAuthVar(id);
	const record = boot();
	if (record.fillGap.has(id) && !record.realEnv.has(id)) {
		delete process.env[id];
		record.fillGap.delete(id);
	}
	return keyStatuses().find((s) => s.id === id)!;
}

// Reflect the file into the env at first import (idempotent; the module is imported by every route/handler path that touches keys).
initAuthEnv();
