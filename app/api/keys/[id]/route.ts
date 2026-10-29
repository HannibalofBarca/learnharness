/** PUT /api/keys/:id — save one key; DELETE — remove it. */
import { isWritableAuthKey } from "@/src/server";
import { deleteKey, saveKey } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params) {
	const { id } = await params;
	if (!isWritableAuthKey(id)) {
		return Response.json({ error: `unknown key "${id}"` }, { status: 404 });
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { value?: unknown }).value !== "string") {
		return Response.json({ error: "body must be {value: string}" }, { status: 400 });
	}
	const result = saveKey(id, (body as { value: string }).value);
	if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
	return Response.json({ status: result.status });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (!isWritableAuthKey(id)) {
		return Response.json({ error: `unknown key "${id}"` }, { status: 404 });
	}
	return Response.json({ status: deleteKey(id) });
}
