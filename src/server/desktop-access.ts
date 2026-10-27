import { timingSafeEqual } from "node:crypto";

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is gated by
 * localBrowserAuthorized below instead. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) return localBrowserAuthorized(headers);
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Browser-only mode (`npm run dev` / `npm start`, key hardening 2026-10-27):
 * no per-launch secret exists, so the gate is "addressed to this machine,
 * sent by the LearnHarness page itself".
 *   - Host must be loopback: defeats DNS rebinding (an attacker domain
 *     re-pointed at 127.0.0.1 still carries its own name in Host).
 *   - Browsers stamp Sec-Fetch-Site and Origin on cross-site requests and
 *     pages cannot forge them: anything not same-origin is refused, so a
 *     website open in another tab cannot drive the API.
 *   - No Origin and no Sec-Fetch-Site = a non-browser local client (curl,
 *     scripts) — allowed: such a process could read auth.json directly.
 */
export function localBrowserAuthorized(headers: Headers): boolean {
	const host = headers.get("host");
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
	const site = headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	const origin = headers.get("origin");
	if (origin !== null) {
		try {
			if (new URL(origin).host !== host) return false;
		} catch {
			return false; // includes the opaque "null" origin
		}
	}
	return true;
}
