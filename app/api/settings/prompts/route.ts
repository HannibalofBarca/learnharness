/** GET /api/settings/prompts — the system-prompt segment view: the effective prompt segments for BOTH agents */

import { effectivePromptSegments, readSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const switches = readSettingsRecord()?.agent?.prompts ?? {};
	return Response.json({
		prober: effectivePromptSegments("prober", switches),
		teacher: effectivePromptSegments("teacher", switches),
	});
}
