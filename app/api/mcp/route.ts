/** POST/GET/DELETE /api/mcp?chat=<id> — the LearnHarness tool server for the learner's Claude Code (docs/claude-code-bridge.md). */
import { handleMcpRequest } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handleMcpRequest;
export const GET = handleMcpRequest;
export const DELETE = handleMcpRequest;
