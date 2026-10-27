/**
 * POST/GET/DELETE /api/mcp?chat=<id> — the LearnHarness tool server for the
 * learner's Claude Code (docs/claude-code-bridge.md). Bearer-token auth in
 * the handler; the proxy lets this path through without the desktop header.
 */
import { handleMcpRequest } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handleMcpRequest;
export const GET = handleMcpRequest;
export const DELETE = handleMcpRequest;
