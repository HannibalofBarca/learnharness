/** GET /api/plans — the Planner page's plan list (newest first). */
import { listPlans } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ plans: listPlans() });
}
