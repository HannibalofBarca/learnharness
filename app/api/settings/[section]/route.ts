/** PUT /api/settings/[section] — section-scoped record writes. */

import type { AgentSettings } from "@/src/core";
import {
	SETTINGS_SECTIONS,
	allSegmentPaths,
	promptOverrides,
	readSettingsRecord,
	writeSettingsRecord,
	type SettingsBodyResult,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** One parser, result type erased to the common envelope. */
type AnySectionParser = (body: unknown) => SettingsBodyResult<unknown>;

export async function PUT(request: Request, ctx: { params: Promise<{ section: string }> }) {
	const { section } = await ctx.params;
	const parser = (SETTINGS_SECTIONS as Record<string, AnySectionParser>)[section];
	if (!parser) {
		return Response.json(
			{ error: `unknown settings section "${section}"`, supported: Object.keys(SETTINGS_SECTIONS) },
			{ status: 404 },
		);
	}
	const body = await request.json().catch(() => null);
	const parsed = parser(body);
	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}
	let agentHealed: AgentSettings | undefined;

	// Section-specific cross-validation (against the prompt store) — the parsers only see shapes.
	if (section === "agent") {
		// Orphan-heal: an ON switch whose override file is gone (or whose segment left the source tree) is healed to OFF (key dropped) inside this write
		const agent = parsed.settings as AgentSettings;
		const segments = new Set(allSegmentPaths());
		const orphans: string[] = [];
		for (const [path, on] of Object.entries(agent.prompts ?? {})) {
			if (on && (!segments.has(path) || promptOverrides.readOverride(path) === null)) orphans.push(path);
		}
		if (orphans.length > 0) {
			const prompts = { ...(agent.prompts ?? {}) };
			for (const path of orphans) delete prompts[path];
			agentHealed = { ...agent, prompts };
			console.info(`[settings] healed orphaned prompt switch(es) to off: ${orphans.join(", ")}`);
		}
	}

	// The agent section lands HEALED when orphaned prompt switches were found above — after every write the record and file reality agree.
	const sectionOut = section === "agent" && agentHealed ? agentHealed : parsed.settings;

	// Read-modify-write ONE section of the record; everything else rides along untouched (other sections, unknown keys — sanitize preserves).
	const record = readSettingsRecord() ?? { version: 1 };
	const next = { ...record, [section]: sectionOut };
	writeSettingsRecord(next);
	return Response.json({ settings: next });
}
