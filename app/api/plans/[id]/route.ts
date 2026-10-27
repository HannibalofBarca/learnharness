/** DELETE /api/plans/:id — delete a plan (its sessions stay). */
import { deletePlan } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	return deletePlan(id) ? Response.json({ ok: true }) : Response.json({ error: "Unknown plan" }, { status: 404 });
}
