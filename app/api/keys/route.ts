/** GET /api/keys — the auth page's key list. */
import { keyStatuses, providerKeyList } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ keys: keyStatuses(), providers: providerKeyList() });
}
