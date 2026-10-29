/** Tests for the settings STORE: src/store/settings.ts — the record's fs adapter. */

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, describe, it } from "node:test";
import { SETTINGS_FILE } from "../config.ts";
import { readSettings, writeSettings } from "../src/store/settings.ts";

// Snapshot any pre-existing record; restore in after() so the worktree's own dev state survives a test run.
let hadSettings = false;
let savedSettings = "";
try {
	savedSettings = fs.readFileSync(SETTINGS_FILE, "utf-8");
	hadSettings = true;
} catch {
	/* first boot — nothing to snapshot */
}
after(() => {
	if (hadSettings) fs.writeFileSync(SETTINGS_FILE, savedSettings, "utf-8");
	else fs.rmSync(SETTINGS_FILE, { force: true });
});

afterEach(() => {
	fs.rmSync(SETTINGS_FILE, { force: true });
});

describe("the settings store", () => {
	it("reads null on first boot (no record)", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		assert.equal(readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});
});
