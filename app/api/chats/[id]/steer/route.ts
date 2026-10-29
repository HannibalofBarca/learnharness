// POST /api/chats/[id]/steer — the composer's mid-turn steering rail.
import { ChatInputError, newUserSteer, parseUserSteerInput } from "@/src/core";
import { getChat, steerClaude } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "unknown chat" }, { status: 404 });
	let input;
	try {
		const body = (await request.json()) as { input?: unknown };
		input = parseUserSteerInput(body?.input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const message = newUserSteer(input.text, input.id);
	if (!steerClaude(id, message)) {
		return Response.json({ error: "no live turn to steer" }, { status: 409 });
	}
	return Response.json({ ok: true });
}
