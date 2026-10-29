import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newPlanBlockMessage, newUserMessage } from "../src/core/native-messages.ts";

import {
	messageFingerprint,
	messageViewLines,
} from "../src/core/coverage.ts";

/** Extraction coverage — the pure core under the TEACHER-PROSE ruling: the extractor sees only the teacher's text blocks; fingerprints, slots, tokens */

function user(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as LhMessage;
}




describe("messageFingerprint — what changes it, what never does", () => {
	it("a text edit changes the fingerprint; role participates", () => {
		const a = messageFingerprint(teacher("m1", "hello world"));
		const b = messageFingerprint(teacher("m1", "hello worlds"));
		const same = messageFingerprint(teacher("m1", "hello world"));
		assert.notEqual(a, b);
		assert.equal(a, same);
		// Role is hashed too — the same words from a LEARNER have no view lines at all (teacher prose only), so the fingerprints differ.
		assert.notEqual(a, messageFingerprint(user("m1", "hello world")));
	});

	it("the message id is the provenance tag — part of exactly what the extractor saw", () => {
		// The view lines carry the [id] tag, so identical content under a different id is a DIFFERENT fingerprint
		assert.notEqual(messageFingerprint(teacher("m1", "same")), messageFingerprint(teacher("m2", "same")));
		// The same id + content re-fingerprints equal.
		assert.equal(messageFingerprint(teacher("m1", "same")), messageFingerprint(teacher("m1", "same")));
	});

	it("marker messages are invisible — a plan-block attach never re-opens anything", () => {
		// Wave D: the marker is its OWN message (not a part on another one); its view is empty
		const marker = newPlanBlockMessage("call_p1", {
			kind: "full",
			at: "2026-09-26T00:00:00.000Z",
			current: null,
			nodes: [],
			edges: [],
		}) as LhMessage;
		assert.deepEqual(messageViewLines(marker, marker.id), []);
		// And the message it rides beside keeps its fingerprint untouched:
		const before = messageFingerprint(teacher("t1", "the chain rule"));
		const withMarker = [teacher("t1", "the chain rule"), marker];
		assert.equal(
			messageFingerprint(withMarker[0]!),
			before,
			"the neighbour's fingerprint is unchanged by the attach",
		);
	});
});
