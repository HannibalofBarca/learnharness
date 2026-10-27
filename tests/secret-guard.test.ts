import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";


/**
 * Key hardening (2026-10-27): the learner-file tools never open the app's
 * secrets (fs-shared.ts's guard), and browser-only mode accepts API calls
 * only from the LearnHarness page on this machine (desktop-access.ts).
 *
 * Fixture (tmpdir) — LH_AUTH_FILE points at a NON-default name so the
 * guard is proven to follow the configured store, not just "auth.json":
 *   keys/my-keys.json              the key store (AUTH_FILE)
 *   keys/chatgpt-credentials.json  subscription login file
 *   keys/readme.txt                ordinary file beside them
 *   notes/.env.local               dev secrets
 *   notes/calc.md                  ordinary note
 *   notes/auth.json                someone else's auth.json — NOT protected
 *   notes/innocent.txt → keys/my-keys.json   (symlink, when permitted)
 *   via-junction → keys/                     (directory junction/symlink)
 */
const SECRET = "sk-secret-value-0123456789";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-secret-"));
const KEYS = path.join(ROOT, "keys");
const NOTES = path.join(ROOT, "notes");
fs.mkdirSync(KEYS);
fs.mkdirSync(NOTES);
const AUTH = path.join(KEYS, "my-keys.json");
fs.writeFileSync(AUTH, JSON.stringify({ OPENAI_API_KEY: SECRET }));
fs.writeFileSync(path.join(KEYS, "chatgpt-credentials.json"), JSON.stringify({ token: SECRET }));
fs.writeFileSync(path.join(KEYS, "readme.txt"), "plain\n");
fs.writeFileSync(path.join(NOTES, ".env.local"), `OPENAI_API_KEY=${SECRET}\n`);
fs.writeFileSync(path.join(NOTES, "calc.md"), "derivative notes\n");
fs.writeFileSync(path.join(NOTES, "auth.json"), "{\"unrelated\":true}\n");
let fileLink = true;
try {
	fs.symlinkSync(AUTH, path.join(NOTES, "innocent.txt"), "file");
} catch {
	fileLink = false; // Windows without symlink privilege
}
fs.symlinkSync(KEYS, path.join(ROOT, "via-junction"), "junction");
process.env.LH_AUTH_FILE = AUTH;

// Dynamic imports: config.ts reads LH_AUTH_FILE at module load.
const { isProtectedPath, walkFiles } = await import("../src/agent/tools/fs-shared.ts");
const { localBrowserAuthorized } = await import("../src/server/desktop-access.ts");

async function walked(root: string): Promise<string[]> {
	const seen: string[] = [];
	await walkFiles(root, (f) => {
		seen.push(f);
		return false;
	});
	return seen;
}

describe("secret-file guard (notes import + folder walks)", () => {
	it("protects the key store, login files and .env files", async () => {
		for (const p of [AUTH, path.join(KEYS, "chatgpt-credentials.json"), path.join(NOTES, ".env.local")]) {
			assert.equal(await isProtectedPath(p), true, p);
		}
	});

	it("protects a secret reached through a symlink or junction", async (t) => {
		assert.equal(await isProtectedPath(path.join(ROOT, "via-junction", "my-keys.json")), true);
		if (!fileLink) return t.skip("file symlinks need privileges here");
		assert.equal(await isProtectedPath(path.join(NOTES, "innocent.txt")), true);
	});

	it("leaves ordinary files alone, including an unrelated auth.json", async () => {
		assert.equal(await isProtectedPath(path.join(NOTES, "calc.md")), false);
		assert.equal(await isProtectedPath(path.join(NOTES, "auth.json")), false);
	});

	it("folder walks never surface secrets, even via a junction", async () => {
		const files = (await walked(ROOT)).map((f) => path.basename(f));
		assert.ok(files.includes("calc.md"));
		assert.ok(!files.some((f) => /my-keys|credentials|^\.env/.test(f)), files.join(", "));
	});
});

describe("browser-only API gate", () => {
	const h = (init: Record<string, string>) => new Headers(init);
	it("allows the LearnHarness page and local non-browser clients", () => {
		assert.ok(localBrowserAuthorized(h({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })));
		assert.ok(localBrowserAuthorized(h({ host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" })));
		assert.ok(localBrowserAuthorized(h({ host: "[::1]:3000" })));
		assert.ok(localBrowserAuthorized(h({ host: "localhost:3000", "sec-fetch-site": "none" })));
	});
	it("refuses other websites, other ports and DNS rebinding", () => {
		assert.ok(!localBrowserAuthorized(h({ host: "localhost:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" })));
		assert.ok(!localBrowserAuthorized(h({ host: "localhost:3000", origin: "https://evil.example" })));
		assert.ok(!localBrowserAuthorized(h({ host: "localhost:3000", origin: "http://localhost:5173", "sec-fetch-site": "same-site" })));
		assert.ok(!localBrowserAuthorized(h({ host: "localhost:3000", origin: "null" })));
		assert.ok(!localBrowserAuthorized(h({ host: "evil.example:3000", origin: "http://evil.example:3000", "sec-fetch-site": "same-origin" })));
		assert.ok(!localBrowserAuthorized(h({ host: "192.168.1.23:3000" })));
		assert.ok(!localBrowserAuthorized(h({})));
	});
});
