/** Tests for the resolution layer: core/settings-resolution.ts — the delta→concrete projection. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractionEnabled,
	renderingEnabled,
	resolveSettings,
} from "../src/core/settings-resolution.ts";
import { BACKGROUND_MODEL_ROLES, type UserSettings } from "../src/core/settings.ts";

describe("resolveSettings", () => {
	it("null record (first boot): non-model knobs land on factory defaults; every model view is EMPTY", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.general, { autoUpdate: true });
		assert.deepEqual(eff.agent.tools, {});
		assert.deepEqual(eff.agent.prompts, {});
		assert.deepEqual(eff.agent.search, {});
		// BYOK: no factory floor — every role undefined, every slot null.
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(eff.agent.models[role], undefined, role);
		}
		assert.equal(eff.models.strong, null);
		assert.equal(eff.models.cheap, null);
		assert.equal(eff.models.vision, null);
		assert.equal(eff.appearance.mode, "dark");
		assert.equal(eff.appearance.background, null);
		assert.equal(eff.appearance.fontFamily, null);
		assert.equal(eff.appearance.proseFontSize, 16);
		assert.equal(eff.appearance.sessionNameSerif, true);
		assert.equal(eff.appearance.mdRendering.headingWeight, 900);
		// wave 7 collapse: the master switch ONLY + the redesign's chunk budget — absent record resolves the factory 4096
		assert.deepEqual(eff.graph, { enabled: true, rendering: true, extractionChunkTokens: 4096 });
	});

	it("explicit record values win over every factory default", () => {
		const record: UserSettings = {
			version: 1,
			general: { autoUpdate: false },
			agent: {
				models: { researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
				tools: { research: false },
				prompts: { "system-prompt.md": true },
				search: { engine: "tavily" },
			},
			appearance: { mode: "light", proseFontSize: 20, mdRendering: { headingWeight: 600 } },
			graph: { enabled: false },
		};
		const eff = resolveSettings(record);
		assert.equal(eff.general.autoUpdate, false);
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "openrouter",
			id: "qwen/qwen3.8-flash",
			// thinking NOT overridden and no cheap slot → UNSET (the engine build resolves it from DEFAULT_THINKING_ORDER, not a pin).
			thinkingLevel: undefined,
		});
		assert.deepEqual(eff.agent.search, { engine: "tavily" });
		assert.deepEqual(eff.agent.tools, { research: false });
		assert.deepEqual(eff.agent.prompts, { "system-prompt.md": true });
		assert.equal(eff.appearance.mode, "light");
		assert.equal(eff.appearance.proseFontSize, 20);
		assert.equal(eff.appearance.mdRendering.headingWeight, 600);
		// wave 7 collapse: the section IS the master switch (absent budget field = factory 4096 — a pre-redesign record resolves cleanly).
		assert.deepEqual(eff.graph, { enabled: false, rendering: true, extractionChunkTokens: 4096 });
		// The DISPLAY split: extraction off leaves the rendering switch ON — the data channel and the view are separate.
		assert.equal(renderingEnabled(eff.graph), true);
		// The chunk budget rides the same resolution: stored value wins.
		const budgeted = resolveSettings({ version: 1, graph: { extractionChunkTokens: 2000 } });
		assert.deepEqual(budgeted.graph, { enabled: true, rendering: true, extractionChunkTokens: 2000 });
	});

	it("graph rendering (2026-10-06): display-only — off resolves off, extraction untouched", () => {
		const eff = resolveSettings({ version: 1, graph: { rendering: false } });
		assert.equal(eff.graph.rendering, false, "stored off wins");
		assert.equal(eff.graph.enabled, true, "the data channel is untouched");
		assert.equal(renderingEnabled(eff.graph), false);
		assert.equal(extractionEnabled(eff.graph), true);
		// absent = factory ON (the home defaults to the canvas)
		assert.equal(resolveSettings({ version: 1, graph: {} }).graph.rendering, true);
	});
});