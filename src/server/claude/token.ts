/** The bridge token: the bearer secret Claude Code presents on /api/mcp and the hook route. */

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";

const TOKEN_FILE = path.join(PATHS.data, "claude", "bridge-token");

let cached: string | undefined;

export function bridgeToken(): string {
	if (cached) return cached;
	try {
		const existing = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
		if (existing.length >= 64) return (cached = existing);
	} catch {
		/* first use */
	}
	const token = randomBytes(32).toString("hex");
	fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
	fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
	return (cached = token);
}

export function bridgeTokenMatches(authorization: string | null): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(authorization.slice("Bearer ".length));
	const wanted = Buffer.from(bridgeToken());
	return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
