import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TurnAgent as Agent } from "../src/server/pi/ui-stream.ts";
import { runPiTurn } from "../src/server/pi/ui-stream.ts";

/** No engine or network: exercise the runner's awaited listener seam. */
function agentEndingWith(loopFailure?: Error): Agent {
	const listeners: Array<(event: never) => unknown> = [];
	return {
		state: { messages: [] },
		subscribe(listener: (event: never) => unknown) { listeners.push(listener); return () => {}; },
		async continue() {
			await Promise.resolve(); // let the view subscribe before the terminal
			if (loopFailure) throw loopFailure;
			for (const listener of listeners) await listener({ type: "agent_end", messages: [] } as never);
		},
		abort() {},
	} as unknown as Agent;
}

function wireFrames(wire: string): string[] {
	return wire.split("\n\n").filter(Boolean).map(frame => frame.slice("data: ".length));
}

describe("turn settlement recovery", () => {
	it("reports a failed canonical save before DONE and cleans up before reporting", async () => {
		const order: string[] = [];
		const handle = runPiTurn({
			agent: agentEndingWith(),
			onFinish() { order.push("save"); throw new Error("synthetic disk failure"); },
			onSettleFailure() { order.push("cleanup"); },
			onSettleError() { order.push("report"); return "The reply could not be saved."; },
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.deepEqual(order, ["save", "cleanup", "report"]);
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
		assert.ok(frames.at(-2)?.includes("The reply could not be saved."));
	});

	it("still reports settlement failure when cleanup itself throws", async () => {
		const handle = runPiTurn({
			agent: agentEndingWith(),
			onFinish() { throw new Error("synthetic save failure"); },
			onSettleFailure() { throw new Error("synthetic cleanup failure"); },
			onSettleError: () => "The reply could not be saved.",
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
	});
});
