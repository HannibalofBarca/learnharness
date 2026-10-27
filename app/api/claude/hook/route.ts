/** POST /api/claude/hook?chat=<id> — the tutor's Stop hook (bearer-token auth). */
import { handleClaudeHook } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handleClaudeHook;
