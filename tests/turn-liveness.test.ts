/** Turn liveness registry unit tests (src/server/turn-liveness.ts): one turn per chat, ever — begin/end round trip, double-begin rejection */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { rememberTurnFailure, settledTurnResponse } from "../src/server/turn-runs.ts";

describe("turn liveness registry", () => {
	it("retains a late-attach failure notice until the next accepted begin", async () => {
		const id = "chat_failure_notice_unit";
		rememberTurnFailure(id, "The reply could not be saved.");
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./);
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./, "reading does not consume the notice");
		assert.equal(beginTurn(id), true);
		assert.doesNotMatch(await settledTurnResponse(id).text(), /"type":"error"/);
		endTurn(id);
	});

	it("begin/end round trip; a second begin is rejected until the turn ends", () => {
		const id = "chat_liveness_unit";
		assert.equal(isTurnRunning(id), false, "initially idle");
		assert.equal(beginTurn(id), true, "first turn accepted");
		assert.equal(isTurnRunning(id), true, "in flight");
		assert.equal(beginTurn(id), false, "no two turns for one chat");
		endTurn(id);
		assert.equal(isTurnRunning(id), false, "cleared at finish");
		assert.equal(beginTurn(id), true, "a new turn may start after the last ended");
		endTurn(id);
	});
});
