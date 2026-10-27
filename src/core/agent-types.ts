/**
 * The native message and tool types the record format is written in.
 *
 * The record format grew up on the pi engine's types (pi-ai / pi-agent-core).
 * Under the Claude Code bridge (docs/claude-code-bridge.md) the engine is
 * gone, but every stored session still IS this shape — so the shapes live
 * here now, copied from those packages' published declarations (the parts
 * the app reads and writes), with no runtime behind them.
 */

import type { Static, TSchema } from "typebox";
import type { LhMarkerMessage } from "./native-messages.ts";

type JsonObject = Record<string, unknown>;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	namespace?: string;
	argumentsError?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	/** Historical engine records name a provider API here; bridged records
	 *  write "anthropic-messages" with provider "claude-code". */
	api: string;
	provider: string;
	model: string;
	responseModel?: string;
	responseId?: string;
	thinkingLevel?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	timestamp: number;
	durationMs?: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	usage?: Usage;
	isError: boolean;
	timestamp: number;
	durationMs?: number;
}

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	timestamp: number;
}

/** A provider-facing conversation message. */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** Any message in a session's history, including the app's custom markers. */
export type AgentMessage = Message | LhMarkerMessage;

export interface AgentToolResult<T = unknown> {
	content: (TextContent | ImageContent)[];
	details: T;
	isError?: boolean;
	/** Historical engine semantics: end the run after this call. */
	terminate?: boolean;
}

/** A LearnHarness tool definition: TypeBox parameters, an optional argument
 *  heal that runs before validation, and the execute body. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> {
	name: string;
	label: string;
	description: string;
	parameters: TParameters;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal) => Promise<AgentToolResult<TDetails>>;
	executionMode?: "sequential" | "parallel";
}

/** The turn stream's event vocabulary (the wire the GUI replays). */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };
