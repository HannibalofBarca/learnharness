/**
 * GET /api/claude/launch?chat=<id> — the desktop shell's terminal asks for
 * the pre-wired Claude Code argv for one session (desktop-header gated by
 * the proxy like every other API route). Writes the per-chat launch files.
 */
import { claudeLaunch } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const url = new URL(req.url);
	const chatId = url.searchParams.get("chat") ?? "";
	const launch = claudeLaunch(chatId, url.origin);
	if (!launch) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json(launch, { headers: { "Cache-Control": "no-store" } });
}
