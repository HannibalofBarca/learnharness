/**
 * The MCP endpoint Claude Code connects to (POST /api/mcp?chat=<id>):
 * stateless streamable HTTP — a fresh server + transport per request, the
 * chat bound by the URL, the caller authenticated by the bridge token.
 *
 * A call that waits for the learner holds its response open; progress
 * notifications every PROGRESS_MS keep Claude Code's idle timeout from
 * firing while they think.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { stores } from "../stores.ts";
import { bridgeTokenMatches } from "./token.ts";
import { callTool, listTools } from "./tools.ts";
import { callPlannerTool, PLANNER_ID, PLANNER_TOOLS } from "./planner.ts";

const PROGRESS_MS = 30_000;

function jsonSchema(schema: unknown): Record<string, unknown> {
	// TypeBox schemas are JSON Schema plus symbol-keyed metadata; a JSON
	// round trip leaves the plain schema.
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function buildServer(chatId: string): Server {
	const server = new Server({ name: "learnharness", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: (chatId === PLANNER_ID ? PLANNER_TOOLS : listTools(chatId)).map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.inputSchema) as never })),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const token = request.params._meta?.progressToken;
		let tick = 0;
		const timer =
			token === undefined
				? undefined
				: setInterval(() => {
						tick += 1;
						void extra
							.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: tick, message: "Waiting for the learner" } })
							.catch(() => undefined);
					}, PROGRESS_MS);
		try {
			const result =
				chatId === PLANNER_ID
					? await callPlannerTool(request.params.name, request.params.arguments ?? {}, extra.signal)
					: await callTool(chatId, request.params.name, request.params.arguments ?? {}, extra.signal);
			return {
				content: [
					{ type: "text" as const, text: result.text },
					...(result.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
				],
				...(result.isError ? { isError: true } : {}),
			};
		} catch (err) {
			return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
		} finally {
			if (timer) clearInterval(timer);
		}
	});
	return server;
}

export async function handleMcpRequest(req: Request): Promise<Response> {
	if (!bridgeTokenMatches(req.headers.get("authorization"))) {
		return Response.json({ error: "Invalid LearnHarness bridge token" }, { status: 401 });
	}
	const chatId = new URL(req.url).searchParams.get("chat") ?? "";
	if (!chatId || (chatId !== PLANNER_ID && !stores.chatStore.getChat(chatId))) {
		return Response.json({ error: "Unknown LearnHarness session" }, { status: 404 });
	}
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
	const server = buildServer(chatId);
	await server.connect(transport);
	return transport.handleRequest(req);
}
