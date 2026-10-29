import { Type } from "typebox";
import type { AgentTool } from "../../core/agent-types.ts";
import { SEND_TO_USER_TOOL } from "../../core/native-messages.ts";
import { serverExecute } from "../tool-execute.ts";

const sendToUserInput = Type.Object({
	message: Type.String({
		minLength: 1,
		pattern: "\\S",
		description: "The complete content to display to the learner. Markdown and LaTeX are supported.",
	}),
});

/** Claude's documented verbatim mid-turn output channel. */
export const sendToUserTool: AgentTool<typeof sendToUserInput> = {
	name: SEND_TO_USER_TOOL,
	label: SEND_TO_USER_TOOL,
	description:
		"## REQUIRED OUTPUT CHANNEL — ALWAYS USE `send_to_user`\n\n" +
		"**ALL learner-facing messages MUST be sent using `send_to_user`.** This includes explanations, teaching, " +
		"feedback, corrections, hints, introductions, progress messages, and final responses. " +
		"There is no exception for short messages or the end of a turn.\n\n" +
		"Ordinary response text may be converted into summarized thinking instead of reaching the learner. " +
		"**Never rely on ordinary response text to communicate with the learner. Thinking is not delivery.**\n\n" +
		"Put the complete message in `message`. Markdown and LaTeX are supported. " +
		"Do not duplicate it in ordinary response text.\n\n" +
		"Question content still belongs in the appropriate question tool; send any accompanying teaching or " +
		"commentary through `send_to_user` before calling that tool.\n\n" +
		"This tool does not pause or end your turn. Continue with other tools when needed. " +
		"After delivering your final message, end the turn without additional ordinary response text.",
	parameters: sendToUserInput,
	executionMode: "sequential",
	execute: serverExecute(SEND_TO_USER_TOOL, sendToUserInput, () => "Message received for display."),
};
