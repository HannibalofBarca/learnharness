import { deleteGraphNode } from "@/src/server";

/** DELETE /api/graph/nodes/[id] — single-node deletion, FULL DEATH. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = deleteGraphNode(id);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	}
	return Response.json({ stats: outcome.stats, graphRevision: outcome.graphRevision });
}