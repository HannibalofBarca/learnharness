/** THE SESSION MARKDOWN EXPORT: the user-facing export the session-markdown engine was built for — the same document the extractor reads */
import { sessionMarkdown } from "@/src/core";
import { getChat } from "@/src/server";

/** Filename-safe title (own module scope on purpose: tiny + pure). */
function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "session";
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const markdown = sessionMarkdown(record.messages, { title: record.title, anchors: false });
	return new Response(markdown, {
		headers: {
			"content-type": "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="${slugify(record.title)}.md"`,
		},
	});
}
