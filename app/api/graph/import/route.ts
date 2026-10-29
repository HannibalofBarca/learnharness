/** POST /api/graph/import — the notes front door under the Claude Code bridge (docs/claude-code-bridge.md). */
import { queueNotes } from "@/src/server";

export const dynamic = "force-dynamic";

const QUEUED =
	'Queued for your tutor. In any session\'s Claude Code terminal, ask: "import my queued notes into the knowledge graph".';

export async function POST(request: Request) {
	const form = await request.formData();
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [], error: "no files" }, { status: 400 });
	}
	const results = [];
	for (const [requestIndex, file] of files.entries()) {
		queueNotes(file.name, await file.text());
		results.push({ requestIndex, filePath: file.name, outcome: "queued" as const, ok: false, error: QUEUED });
	}
	return Response.json({ results });
}
