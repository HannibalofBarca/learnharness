import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string; homepage: string };

const nextConfig: NextConfig = {
	// Public build metadata only; no new runtime Electron version API.
	env: { LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage },
	// Desktop target: standalone output = a self-contained .next/standalone/server.js the Electron shell spawns on 127.0.0.1.
	output: "standalone",
	// SAFETY: without this, output file tracing sweeps the repo's real data/ — chat records, graph ledgers — INTO the standalone bundle.
	outputFileTracingExcludes: {
		"*": [
			"**/data/**/*",
			"auth.json",
			"chatgpt-credentials.json*",
			"github-copilot-credentials.json*",
			"xai-credentials.json*",
			".env*",
		],
	},
	// Empirically verified gaps: the tracer misses JSON loaded via `import ... with { type: "json" }` attributes
	outputFileTracingIncludes: {
		"*": [
			// The standalone trace omitted this entire runtime-imported directory in 0.3.0, so importing puppeteer-core failed before browser startup.
			"node_modules/@puppeteer/browsers/lib/browser-data/**/*.js",
			"node_modules/pdfjs-dist/legacy/**/*",
			"node_modules/pdfjs-dist/standard_fonts/**/*",
			// Wave E: pdf_render paints via @napi-rs/canvas
			"node_modules/@napi-rs/canvas-*/**/*",
			// Wave E stage 2: resvg rasterizes visual-maker SVGs natively; same per-platform-binary story as the canvas above (one per build).
			"node_modules/@resvg/resvg-js-*/**/*",
		],
	},
	// Framework-free core lives in src/ (plain TS, imported by routes and CLI alike).
	serverExternalPackages: [
		"pdfjs-dist", // sources v0: bundling breaks its node fake-worker path
		"@napi-rs/canvas", // native binding — bundling breaks the .node require
		"@resvg/resvg-js", // native binding — same
	],
};

export default nextConfig;