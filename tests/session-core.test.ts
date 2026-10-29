/** SESSION MODEL tests: the pure state machine that replaced useChat + the AI-SDK transport. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import type { ChatInput } from "../src/core/input-events.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** SSE-frame each object the way the server's subscriber stream does. */
function sse(...events: unknown[]): string {
	return events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join("");
}


/** A plain single-read 200 body. */
function sseResponse(...events: unknown[]): Response {
	return new Response(sse(...events), { status: 200 });
}

/** CONNECTION DIET B mock: send() no longer consumes the POST response — it acks, closes, and reattaches. */
function dietFetch(opts: {
	stream: () => Response;
	userText?: string;
	post?: () => Response;
	onPost?: (body: string) => void;
}): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/chat") {
			if (opts.onPost && typeof init?.body === "string") opts.onPost(init.body);
			return opts.post?.() ?? Response.json({ ok: true });
		}
		if (url === "/api/chats/chat_x") {
			const messages =
				opts.userText === undefined ? [] : [{ id: "u1", role: "user", content: opts.userText, timestamp: 1 }];
			return Response.json({ messages });
		}
		if (url === "/api/chats/chat_x/stream") return opts.stream();
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
}


/** A streaming assistant partial (pi events carry the FULL partial — and NO message.id */
function partial(blocks: unknown[], stopReason?: string): Record<string, unknown> {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: blocks,
			...(stopReason ? { stopReason } : {}),
			usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
			provider: "openrouter",
			model: "test",
		},
		assistantMessageEvent: { type: "text", textDelta: "" },
	};
}

function model(opts: Partial<ConstructorParameters<typeof SessionModel>[0]> = {}): SessionModel {
	return new SessionModel({ chatId: "chat_x", initialMessages: [], ...opts });
}

// ─── the 409 identity-retry ────────────────────────────────────────────────

interface Call {
	url: string;
	body: string | undefined;
}

function installFetch(routes: {
	chatPOST: (call: Call, attempt: number) => Response;
	jobsGET?: (poll: number) => boolean;
}): Call[] {
	const calls: Call[] = [];
	let poll = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: init?.body as string | undefined });
		if (url === "/api/chat" && init?.method === "POST") {
			return routes.chatPOST(calls.at(-1)!, calls.filter((c) => c.url === "/api/chat").length);
		}
		if (url.startsWith("/api/jobs")) return Response.json({ turnInFlight: routes.jobsGET?.(++poll) ?? false });
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
	return calls;
}

describe("postInputEvent (the 409 identity-retry)", { skip: process.env.NO_SLOW ? true : undefined }, () => {
	it("the model's default fetch is RECEIVER-SAFE (the browser 'Illegal invocation' pin)", async () => {
		// The live empty-session bug: storing globalThis.fetch UNBOUND and calling it as this.fetch(...) throws "Illegal invocation" in the browser (native
		let receiverWasGlobal = false;
		globalThis.fetch = (function (this: unknown) {
			if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
			receiverWasGlobal = true;
			return Promise.resolve(sseResponse("[DONE]"));
		}) as typeof fetch;
		const m = model(); // NO injected fetch — exercises the default wrapper
		const res = await m.postInputEvent({ type: "text", text: "hi" });
		assert.equal(res.status, 200);
		assert.ok(receiverWasGlobal, "the default wrapper calls fetch with the global receiver");
	});

	it("passes non-409 responses through untouched", async () => {
		const calls = installFetch({ chatPOST: () => new Response("stream", { status: 200 }) });
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent({ type: "text", text: "hi" });
		assert.equal(res.status, 200);
		assert.equal(calls.length, 1, "no polling, single call");
		assert.deepEqual(JSON.parse(calls[0]!.body!), { chatId: "chat_x", input: { type: "text", text: "hi" } });
	});

	it("waits out the turn, then re-POSTs the SAME event body (identity retry)", async () => {
		const event: ChatInput = { type: "text", text: "my question while the wake turn ran" };
		const calls = installFetch({
			chatPOST: (_c, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
			jobsGET: (poll) => poll <= 1, // first poll: still running; second: done
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent(event);
		assert.equal(res.status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 2, "one 409, one retry");
		assert.equal(posts[1]!.body, posts[0]!.body, "the event body is byte-identical");
	});

	it("never reads the record — the event is the only payload", async () => {
		const calls = installFetch({
			chatPOST: (_c, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		assert.equal((await m.postInputEvent({ type: "text", text: "q" })).status, 200);
		assert.equal(
			calls.filter((c) => c.url.startsWith("/api/chats/")).length,
			0,
			"the retry never reads the record — the server owns it",
		);
	});

	it("loops on repeated 409s, re-POSTing the same event each time", async () => {
		const event: ChatInput = { type: "answer", toolCallId: "call-1", answer: { correct: true } as never };
		const calls = installFetch({
			chatPOST: (_c, n) => (n <= 2 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		assert.equal((await m.postInputEvent(event)).status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 3);
		assert.ok(posts.every((c) => c.body === posts[0]!.body), "every attempt carries the same event");
	});

	it("gives up after the deadline and surfaces the last 409", async () => {
		const calls = installFetch({
			chatPOST: () => new Response("busy", { status: 409 }),
			jobsGET: () => true,
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent({ type: "text", text: "q" });
		assert.equal(res.status, 409);
		const polls = calls.filter((c) => c.url.startsWith("/api/jobs")).length;
		assert.ok(polls <= 15, `expected bounded polling (~10×10ms), got ${polls}`);
	});
});

// ─── send: optimistic appends + wire consumption ────────────────────────────

describe("send (one input event, verbatim consumption)", () => {
	it("optimistically appends the text, POSTs {chatId, input}, consumes to [DONE]", async () => {
		const posts: string[] = [];
		globalThis.fetch = dietFetch({
			onPost: (b) => posts.push(b),
			userText: "my topic", // the write-ahead the record refetch absorbs
			stream: () =>
				sseResponse(
					{ type: "agent_start" },
					{ type: "message_start", message: { role: "assistant", content: [] } },
					partial([{ type: "text", text: "hello there" }]),
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello there" }], stopReason: "stop" } },
					{ type: "agent_end", messages: [] },
					"[DONE]",
				),
		});

		const m = model();
		const pending = m.send({ type: "text", text: "my topic" });
		// The optimistic bubble is INSTANT (the instant-answer UX seam):
		assert.equal(m.getState().status, "submitted");
		assert.match((m.getState().nativeMessages.at(-1) as { id?: string }).id ?? "", /^c_/);
		assert.equal(m.getState().messages.at(-1)!.parts[0]!.text, "my topic");
		await pending;
		assert.deepEqual(JSON.parse(posts[0]!), { chatId: "chat_x", input: { type: "text", text: "my topic" } });
		assert.equal(m.getState().status, "ready");
		// The streamed assistant REPLACED through full partials (never deltas):
		const view = m.getState().messages;
		assert.equal(view.at(-1)!.role, "assistant");
		assert.equal(view.at(-1)!.parts.at(-1)!.text, "hello there");
	});

	it("N id-less updates replace the SAME tail slot (the per-chunk divider bug pin)", async () => {
		// pi's wire: message_start/update/end carry AssistantMessages with NO id.
		let push: (e: unknown) => void = () => {};
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (e) => controller.enqueue(enc.encode(e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`));
			},
		});
		globalThis.fetch = dietFetch({ userText: "go", stream: () => new Response(body, { status: 200 }) });
		const m = model();
		const done = m.send({ type: "text", text: "go" });
		const settle = () => new Promise((r) => setTimeout(r, 0));

		push({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } });
		for (const text of ["Hel", "Hello", "Hello wor", "Hello world"]) {
			push(partial([{ type: "thinking", thinking: "hmm" }, { type: "text", text }]));
			await settle();
		}
		// MID-STREAM: exactly ONE assistant message in the tail — never one per chunk — carrying the LATEST partial (full snapshot, not deltas).
		const assistants = m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "assistant");
		assert.equal(assistants.length, 1, "one streaming message, replaced in place");
		assert.equal(m.getState().messages.at(-1)!.parts.filter((p) => p.type === "text").length, 1);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "Hello world");
		// Stable id across updates → stable view-part keys (no per-chunk remount of the whole transcript, mermaid included).
		const idMid = (assistants[0] as { id?: string }).id;
		assert.match(idMid ?? "", /^c_/, "client-minted slot id");

		push({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello world" }], stopReason: "stop" } });
		push({ type: "agent_end", messages: [] });
		push("[DONE]");
		await done;
		const final = m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "assistant");
		assert.equal(final.length, 1);
		assert.equal((final[0] as { id?: string }).id, idMid, "same slot through message_end");
	});
});

// ─── adoption ──────────────────


// ─── the continuation fold (mount/sync seam) ────────────────────────────────



// ─── the practice live-view law ───────────────────────── The two-spinners + doubled-card incident

