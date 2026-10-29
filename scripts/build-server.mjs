/** build-server.mjs — curate the Electron shell's server payload. */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

const copyTree = (from, to) => {
	fs.cpSync(from, to, { recursive: true });
};

const exists = (p) => fs.existsSync(p);

if (!exists(path.join(STANDALONE, "server.js"))) {
	console.error("[build-server] .next/standalone/server.js missing — run `next build` first (output: 'standalone').");
	process.exit(1);
}

// 1) Static assets: public/ → standalone/public, .next/static → standalone/.next/static
const staticFrom = path.join(ROOT, ".next", "static");
const staticTo = path.join(STANDALONE, ".next", "static");
if (!exists(staticFrom)) {
	console.error("[build-server] .next/static missing — the build looks incomplete.");
	process.exit(1);
}
copyTree(staticFrom, staticTo);
if (exists(path.join(ROOT, "public"))) {
	copyTree(path.join(ROOT, "public"), path.join(STANDALONE, "public"));
}

// 2) Safety: the repo's real data/ must NEVER ride along in the bundle.
const leakedData = path.join(STANDALONE, "data");
if (exists(leakedData)) {
	console.error("[build-server] REFUSING: standalone contains a data/ directory — repo session data would ship in the app.");
	console.error("             Check outputFileTracingExcludes in next.config.ts.");
	process.exit(1);
}

// 2b) Safety: the repo's dev SECRETS must never ride along either
const subscriptionSecrets = fs.readdirSync(STANDALONE).filter((name) => /^(chatgpt|github-copilot|xai)-credentials\.json/.test(name));
for (const secret of ["auth.json", ...subscriptionSecrets, ".env", ".env.local"]) {
	if (exists(path.join(STANDALONE, secret))) {
		console.error(`[build-server] REFUSING: standalone contains ${secret} — dev secrets would ship in the app.`);
		console.error("             Check outputFileTracingExcludes in next.config.ts.");
		process.exit(1);
	}
}

// 2c) Payload curation: the trace sweep can copy repo-root dist/ (previous installers
for (const extra of ["dist", path.join("node_modules", "electron")]) {
	const target = path.join(STANDALONE, extra);
	if (exists(target)) {
		fs.rmSync(target, { recursive: true, force: true });
		console.log(`[build-server] removed build-only payload: ${extra}`);
	}
}

// 3) Sanity: the runtime-read prompt assets must be present (the teacher agent reads them from disk at request time).
for (const asset of [
	path.join("src", "agent", "system-prompt.md"),
	path.join("src", "agent", "prompts", "teacher", "20-teaching.md"),
]) {
	if (!exists(path.join(STANDALONE, asset))) {
		console.error(`[build-server] prompt asset missing from the trace: ${asset}`);
		process.exit(1);
	}
}

console.log("[build-server] server payload ready:", STANDALONE);