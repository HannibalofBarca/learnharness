/**
 * POST /api/graph/coverage/extract — the manual "extract now" button. Under
 * the Claude Code bridge (docs/claude-code-bridge.md) extraction is done by
 * the session's tutor Claude (graph_extract_next …), which the app cannot
 * start on its own; the answer tells the learner how to ask for it.
 */
export const dynamic = "force-dynamic";

export async function POST() {
	return Response.json(
		{ error: 'Extraction runs through your tutor: in this session\'s Claude Code terminal, ask "update the knowledge graph from this session".' },
		{ status: 409 },
	);
}
