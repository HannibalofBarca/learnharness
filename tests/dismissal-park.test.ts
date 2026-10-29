/** PARKED DISMISSALS: ESC-discard while the turn is still working. */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dismissal-park-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { applyParkedDismissal, parkDismissal, takeParkedDismissal } = await import(
	"../src/server/dismissal-park.ts"
);
const { subscribe } = await import("../src/core/events.ts");
const {
	answeredCallIds,
	danglingQuestionOf,
	dismissedAnswer,
} = await import("../src/core/index.ts");
const newMessageId = (await import("../src/core/native-messages.ts")).newMessageId;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** A record whose newest assistant message carries a DANGLING quiz call — the settled state a mid-turn dismissal parks against. */
function chatWithDanglingQuiz(id: string): string {
	const chat = chatStore.createChat("park: dangling quiz");
	chatStore.saveMessages(chat.id, [{
		id: newMessageId(),
		role: "assistant",
		content: [
			{ type: "text", text: "Quick check:" },
			{
				type: "toolCall",
				id: `${id}-q1`,
				name: "quiz",
				arguments: { question: "What is a cyclic group?" },
			},
		],
	} as never]);
	return chat.id;
}


describe("the park registry", () => {
	it("parks and takes (take drains — the second read is null)", () => {
		parkDismissal("chat_x", { type: "dismiss-problem", problemCallId: "p" });
		assert.deepEqual(takeParkedDismissal("chat_x"), { type: "dismiss-problem", problemCallId: "p" });
		assert.equal(takeParkedDismissal("chat_x"), null);
	});

	it("apply with nothing parked is a no-op (no write, no emit)", () => {
		const chat = chatWithDanglingQuiz("noop");
		const before = chatStore.getChat(chat)!.messages.length;
		let emitted = 0;
		const off = subscribe((e) => {
			if (e.type === "record-changed" && e.chatId === chat) emitted++;
		});
		applyParkedDismissal(chatStore, chat);
		off();
		assert.equal(emitted, 0);
		assert.equal(chatStore.getChat(chat)!.messages.length, before);
	});
});

describe("applyParkedDismissal — against real records", () => {
	it("applies a parked question dismissal to the dangling quiz call", () => {
		const chat = chatWithDanglingQuiz("apply-q");
		const pending = danglingQuestionOf(chatStore.getChat(chat)!.messages);
		assert.ok(pending);
		parkDismissal(chat, {
			type: "dismiss",
			toolCallId: pending!.toolCallId,
			answer: dismissedAnswer("quiz", "What is a cyclic group?"),
		});
		let emitted = 0;
		const off = subscribe((e) => {
			if (e.type === "record-changed" && e.chatId === chat) emitted++;
		});
		applyParkedDismissal(chatStore, chat);
		off();
		assert.equal(emitted, 1);
		// The call is answered now — nothing dangles.
		assert.equal(danglingQuestionOf(chatStore.getChat(chat)!.messages), null);
		assert.ok(answeredCallIds(chatStore.getChat(chat)!.messages).has(pending!.toolCallId));
		assert.equal(takeParkedDismissal(chat), null);
	});
});
