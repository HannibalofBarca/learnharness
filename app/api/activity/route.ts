/** GET /api/activity — the dock's one poll: every running background process, every view (chat, home, everywhere). */
import { activityFeed } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(activityFeed());
}
