/** GET /api/tree — the learning tree for the Planner page's canvas. */
import { treeView } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(treeView());
}
