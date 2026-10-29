import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";


/** Key hardening: the learner-file tools never open the app's secrets (fs-shared.ts's guard) */
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
const { isProtectedPath } = await import("../src/agent/tools/fs-shared.ts");


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
});
