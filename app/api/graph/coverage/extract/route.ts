/** POST /api/graph/coverage/extract — the manual "extract now" button. */
export const dynamic = "force-dynamic";

export async function POST() {
	return Response.json(
		{ error: 'Extraction runs through your tutor: in this session\'s Claude Code terminal, ask "update the knowledge graph from this session".' },
		{ status: 409 },
	);
}
