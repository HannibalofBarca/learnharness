/**
 * ClaudeHarness never self-updates: the inherited update feed is the
 * upstream LearnHarness repository, so an update would replace this fork
 * with the original app (it happened once — 0.3.9 over the fork build).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("updates are disabled", () => {
	it("the shell reports the updater disabled before touching electron-updater", () => {
		const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
		const setup = main.slice(main.indexOf("function setupAutoUpdater()"));
		assert.ok(setup.indexOf('reportUpdateStatus("disabled")') < setup.indexOf('require("electron-updater")'));
		assert.match(setup, /auto-update: disabled in this fork/);
	});

	it("the build records no update feed", () => {
		const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
		assert.match(builder, /^publish: null$/m);
		assert.doesNotMatch(builder, /owner: amosblomqvist/);
	});
});
