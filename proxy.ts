import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized, localBrowserAuthorized } from "./src/server/desktop-access.ts";

/** The Claude Code bridge's own routes (docs/claude-code-bridge.md): called
 *  by the tutor's Claude Code, which cannot carry the desktop window's
 *  header. They must still be loopback and never cross-site; the bridge
 *  token is checked in the route handlers. */
const BRIDGE_PATHS = ["/api/mcp", "/api/claude/hook"];

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
	const bridge = BRIDGE_PATHS.some((p) => request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(`${p}/`));
	const authorized = bridge ? localBrowserAuthorized(request.headers) : desktopAPIAuthorized(request.headers);
	if (!authorized) {
		return NextResponse.json(
			{ error: "API access requires the trusted LearnHarness window on this machine." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
