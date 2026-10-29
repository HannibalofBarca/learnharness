/** THE COMPOSITION ROOT for storage — the single place concrete store adapters are wired. */

import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
};


/** The resolved view of the settings record (core/settings-resolution.ts): every knob concrete over its factory default — EXCEPT MODELS */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
