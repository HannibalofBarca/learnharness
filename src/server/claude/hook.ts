/**
 * POST /api/claude/hook?chat=<id> — Claude Code's Stop hook (curl from the
 * pre-wired settings, payload on stdin → request body).
 *
 * The tutor must end every reply on a blocking tool; when it stops without
 * one, the GUI would sit on an open turn. So: if nothing is parked and the
 * hook has not already forced a continuation, answer `decision: block` with
 * the reason Claude reads; otherwise let it stop and settle the turn.
 * The payload's session_id also records which Claude conversation backs
 * this chat (covers the fresh-after-failed-resume launch).
 */

import { stores } from "../stores.ts";
import { rememberClaudeSession } from "./launch.ts";
import { PLANNER_ID, rememberPlannerSession } from "./planner.ts";
import { claudeSession } from "./session.ts";
import { bridgeTokenMatches } from "./token.ts";

const REASON =
	"Your reply is not finished: the learner only sees what you send through the LearnHarness tools. " +
	"If you have not sent your text with send_to_user, do it now; then end with wait_for_learner or a question tool.";

export async function handleClaudeHook(req: Request): Promise<Response> {
	if (!bridgeTokenMatches(req.headers.get("authorization"))) {
		return Response.json({ error: "Invalid LearnHarness bridge token" }, { status: 401 });
	}
	const chatId = new URL(req.url).searchParams.get("chat") ?? "";
	if (chatId === PLANNER_ID) {
		// The planner talks in its terminal: record its conversation, never block.
		const body = (await req.json().catch(() => ({}))) as { session_id?: unknown };
		if (typeof body.session_id === "string" && body.session_id) rememberPlannerSession(body.session_id);
		return Response.json({});
	}
	if (!stores.chatStore.getChat(chatId)) return Response.json({});
	let payload: { session_id?: unknown; stop_hook_active?: unknown; hook_event_name?: unknown } = {};
	try {
		payload = await req.json();
	} catch {
		/* an empty body still answers */
	}
	if (typeof payload.session_id === "string" && payload.session_id) rememberClaudeSession(chatId, payload.session_id);

	const session = claudeSession(chatId);
	if (session.blocked) return Response.json({});
	if (payload.stop_hook_active !== true) {
		return Response.json({ decision: "block", reason: REASON });
	}
	// Claude stopped twice in a row: let it, and close the GUI's open turn.
	session.agent?.settle();
	return Response.json({});
}
