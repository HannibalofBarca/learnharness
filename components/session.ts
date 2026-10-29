"use client";

/** THE SESSION HOOK: the React adapter over the pure SessionModel (components/session-core.ts — the state machine, testable without a renderer). */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ChatInput, LhMessage, QuestionAnswerData } from "@/src/core";
import { SessionModel, type SessionState } from "@/components/session-core";

interface UseChatSessionOptions {
	chatId: string;
	/** The native record seed (server-rendered page or a full sync). */
	initialMessages: LhMessage[];
	/** Transient settlement failure retained by the server, not the transcript. */
	initialError?: string;
	/** Reattach on mount: a turn is running server-side with no live view. */
	initiallyInFlight?: boolean;
}

export function useChatSession({ chatId, initialMessages, initialError, initiallyInFlight }: UseChatSessionOptions) {
	// The model is per-mount (chatId-keyed component); onChange forces the re-render.
	const modelRef = useRef<SessionModel | null>(null);
	if (modelRef.current === null) {
		modelRef.current = new SessionModel({ chatId, initialMessages, initialError });
	}
	const model = modelRef.current;
	// The render VERSION — bumped by every model change, so the state memo below recomputes exactly when the model actually changed.
	const [version, bump] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		model.onChange = bump;
		return () => {
			model.onChange = undefined;
		};
	}, [model, bump]);

	// Reattach on mount (StrictMode-safe: a newer resume cancels the older).
	useEffect(() => {
		if (initiallyInFlight) void model.resumeStream(false);
		return () => {
			model.stop();
		};
	}, [initiallyInFlight, model]);

	// The view + state, derived per model change from the model.
	const state = useMemo<SessionState>(() => model.getState(), [model, version] as const);

	// THE TURN-STATE BROADCAST: the same optimistic machine, propagated — the instant a turn starts locally (submitted: send, answer, session start
	const prevStatusRef = useRef(state.status);
	useEffect(() => {
		const was = prevStatusRef.current;
		prevStatusRef.current = state.status;
		if (was === state.status) return;
		const running = state.status === "submitted" || state.status === "streaming";
		const wasRunning = was === "submitted" || was === "streaming";
		if (running === wasRunning) return; // submitted→streaming: still running; error↔ready: not
		window.dispatchEvent(new CustomEvent("lh:turn-state", { detail: { id: chatId, running } }));
	}, [state.status, chatId]);

	// The reattach settled terminal → the sync-and-continue seam (chat.tsx).
	const setReattachSettled = useCallback(
		(fn: () => void) => {
			model.setReattachSettled(fn);
		},
		[model],
	);

	const send = useCallback((input: ChatInput) => void model.send(input), [model]);
	const continueIfOwed = useCallback((record: readonly LhMessage[]) => void model.continueIfOwed(record), [model]);
	const steer = useCallback((text: string) => void model.steer(text), [model]);
	const submitAnswer = useCallback(
		(tool: string, toolCallId: string, output: QuestionAnswerData) =>
			void model.submitAnswer(tool, toolCallId, output),
		[model],
	);
	const dismissQuestion = useCallback(
		(toolCallId: string, answer: QuestionAnswerData) => void model.dismissQuestion(toolCallId, answer),
		[model],
	);
	const dismissProblem = useCallback(
		(problemCallId: string) => void model.dismissProblem(problemCallId),
		[model],
	);
	const questionDraft = useCallback((toolCallId: string) => model.questionDraft(toolCallId), [model]);
	const saveQuestionDraft = useCallback((toolCallId: string, draft: Parameters<SessionModel["saveQuestionDraft"]>[1]) => model.saveQuestionDraft(toolCallId, draft), [model]);
	const setMessages = useCallback((record: LhMessage[], turnError?: string) => model.setMessages(record, turnError), [model]);
	const adoptRecord = useCallback((record: LhMessage[]) => model.adoptRecord(record), [model]);
	const stop = useCallback(() => model.stop(), [model]);
	const clearError = useCallback(() => model.clearError(), [model]);
	const resumeStream = useCallback(() => void model.resumeStream(), [model]);

	return {
		messages: state.messages,
		nativeMessages: state.nativeMessages,
		contextTokens: state.contextTokens,
		status: state.status,
		error: state.error,
		steerQueue: state.steerQueue,
		send,
		continueIfOwed,
		steer,
		submitAnswer,
		dismissQuestion,
		dismissProblem,
		questionDraft,
		saveQuestionDraft,
		setMessages,
		adoptRecord,
		stop,
		clearError,
		resumeStream,
		setReattachSettled,
	};
}
