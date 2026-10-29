/**
 * THE CORE PUBLIC API — the only module the shell (app/, components/) may
 * import. Everything exported here is browser-safe: pure logic + types,
 * no node builtins, no fs, no network.
 *
 * Server-side surfaces (chat streaming, store reads) live behind
 * src/server's barrel instead — the import law (eslint.config.mjs):
 *
 *   components/**  →  "@/src/core"        (this barrel, ONLY)
 *   app/**         →  "@/src/core" + "@/src/server"
 *
 * Server-only core modules (core/graph.ts emission/derivation) are pure
 * but need storage ports passed in by a server caller, so they are
 * deliberately NOT re-exported here — the server imports them directly.
 * The storage PORT TYPES are types-only and browser-safe, hence re-exported.
 */

export * from "./contracts.ts";
export * from "./ports.ts";
export * from "./chains.ts";
export * from "./render-settings.ts";

export * from "./question-core.ts";
// The event bus: vocabulary + emit/subscribe for every layer; the browser shell consumes the types + the runtime names through this barrel (shell law
export * from "./events.ts";
// clusters.ts (Louvain) is deliberately NOT re-exported: nothing in the shell runs community detection
export * from "./layout.ts";
export * from "./plan-tree.ts";
export * from "./phases.ts";
export * from "./pending.ts";
export * from "./prompt-segments.ts";
export * from "./math-delims.ts";
// Wave B: the native record (LhMessage), the and the input-events contract — all pure logic, browser-safe.
export * from "./native-messages.ts";
export * from "./compaction.ts";
export * from "./input-events.ts";
// Wave D: the client view model — the grouping canon (one continuous assistant document
export * from "./view.ts";
export * from "./tool-parts.ts";
export * from "./answer-presentation.ts";
export * from "./context-usage.ts";
export * from "./fuzzy.ts";
// settings.ts + settings-resolution.ts: the user-settings record's shape/sanitizer (pure) and its fully-resolved view.
export * from "./settings.ts";
// graph-deletion.ts: the whole module is PURE but storage-port driven — the deletion RUNS server-side only.
export type { ChatDeleteMode } from "./graph-deletion.ts";
export * from "./settings-resolution.ts";
export * from "./search.ts"; // search port
export * from "./session-find.ts";
export * from "./session-navigation.ts";
// auth-keys.ts: the curated key catalog + shape rules + masking — pure, browser-safe (the auth page binds to the /api/keys routes built on it).
export * from "./auth-keys.ts";
// keyboard.ts: the shortcut registry + binding normalization (pure, browser-safe).
export * from "./keyboard.ts";
export * from "./coverage.ts";
// session-markdown.ts: the ONE session→markdown formatter — the extractor's view and the user-facing export share it.
export * from "./session-markdown.ts";
export type * from "./agent-types.ts";
