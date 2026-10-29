/** Tests for the section parsers: src/server/settings-body.ts — general/agent/appearance/graph strictness. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseAgentSettingsBody,
	parseGeneralSettingsBody,
} from "../src/server/settings-body.ts";

describe("parseGeneralSettingsBody", () => {
	it("parses {} and {autoUpdate} replace-whole", () => {
		const empty = parseGeneralSettingsBody({});
		assert.ok(empty.ok);
		assert.deepEqual(empty.settings, {});
		const on = parseGeneralSettingsBody({ autoUpdate: true });
		assert.ok(on.ok);
		assert.deepEqual(on.settings, { autoUpdate: true });
	});

	it("rejects non-objects and non-boolean autoUpdate", () => {
		assert.equal(parseGeneralSettingsBody("x").ok, false);
		assert.equal(parseGeneralSettingsBody({ autoUpdate: "yes" }).ok, false);
	});
});

describe("parseAgentSettingsBody", () => {
	it("models: valid roles with model pair and/or thinkingLevel; unknown role is a 400 with the list", () => {
		const r = parseAgentSettingsBody({
			models: {
				researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
				auditor: { thinkingLevel: "high" },
			},
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings.models, {
			researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
			auditor: { thinkingLevel: "high" },
		});
		const bad = parseAgentSettingsBody({ models: { teacher: {} } });
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.match(bad.error, /unknown role "teacher" \(supported: researcher, demoBuilder, visualMaker, extractor, auditor\)/);
		const malformed = parseAgentSettingsBody({ models: { researcher: { model: { provider: 1, id: "x" } } } });
		assert.equal(malformed.ok, false);
	});
});
