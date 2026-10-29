/** THE SERVER-SIDE SURFACE — the only src module (besides the core barrel) that app/ may import. */

export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
export * from "./stores.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
// The settings record + prompt overrides.
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export { promptOverrides } from "../store/prompt-overrides.ts";
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// The canonical segment discovery/resolution lives in the agent layer (composition is an agent concern); the barrel re-exports it for the routes
export { effectivePromptSegments, allSegmentPaths } from "../agent/prompt-segments.ts";

// The auth/keys composition: the curated key catalog + the env-reflecting store behind GET/PUT/DELETE /api/keys.
export * from "./keys.ts";
export * from "./settings-body.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export { piTurnResponse } from "./pi/ui-stream.ts";
export * from "./observability.ts";
// The Claude Code bridge (docs/claude-code-bridge.md).
export { handleMcpRequest } from "./claude/mcp.ts";
export { handleClaudeHook } from "./claude/hook.ts";
export { claudeLaunch } from "./claude/launch.ts";
export { queueNotes } from "./claude/graph-tools.ts";
export { plannerLaunch, PLANNER_ID } from "./claude/planner.ts";
export { openBranchSession, treeView } from "./claude/learning-tree.ts";
