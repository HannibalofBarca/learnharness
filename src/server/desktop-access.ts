import { timingSafeEqual } from "node:crypto";

/** Per-launch desktop HTTP capability. */
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

/** Browser-only mode: no per-launch secret exists, so the gate is "addressed to this machine, sent by the LearnHarness page itself". */
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
