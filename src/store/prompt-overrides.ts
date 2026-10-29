/** The prompt-override STORE: the override-file CRUD behind the core port — list/read/write/delete under config.PROMPTS_OVERRIDE_DIR. */

import fs from "node:fs";
import path from "node:path";
import { PROMPTS_OVERRIDE_DIR } from "../../config.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import type { PromptOverrideStore } from "../core/ports.ts";

/** Absolute path for an override file (unchecked — validate first). */
function overrideFileFor(segmentPath: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, ...segmentPath.split("/"));
}

/** The store adapter (core/ports.ts). */
export const promptOverrides: PromptOverrideStore = {
	listOverrides(): string[] {
		const out: string[] = [];
		const walk = (dir: string, prefix: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return; // no dir yet = no overrides
			}
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
				else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(rel)) out.push(rel);
			}
		};
		walk(PROMPTS_OVERRIDE_DIR, "");
		return out.sort();
	},

	readOverride(segmentPath: string): string | null {
		if (!isValidSegmentPath(segmentPath)) return null;
		try {
			return fs.readFileSync(overrideFileFor(segmentPath), "utf-8");
		} catch {
			return null;
		}
	},

	writeOverride(segmentPath: string, text: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		const file = overrideFileFor(segmentPath);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text, "utf-8");
	},

	deleteOverride(segmentPath: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		try {
			fs.unlinkSync(overrideFileFor(segmentPath));
		} catch {
			// absent already = done
		}
	},
};
