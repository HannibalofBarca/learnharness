/** POST /api/tree/:id/session — open a new teaching session on a tree node. */
import { openBranchSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	const out = openBranchSession(id);
	return "error" in out ? Response.json(out, { status: 404 }) : Response.json(out);
}
