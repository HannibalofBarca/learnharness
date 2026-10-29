/** GET /api/settings — THE user settings record: the whole delta record at data/settings.json (config. */

import { settingsStore } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ settings: settingsStore.readSettings() });
}
