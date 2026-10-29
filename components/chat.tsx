"use client";

import { createContext, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChatSession } from "@/components/session";
import { ClaudeTerminal } from "@/components/claude-terminal";
import { visibleQueuedSteers } from "@/components/session-core";
import { Hint } from "@/components/ui/hint";
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { LiveToolCard } from "@/components/artifacts/live-tool-card";
import { Separator } from "@/components/ui/separator";
import { AnsweredCard } from "@/components/answered-card";
import { artifactRenderers } from "@/components/artifacts";
import { SubagentSteerCard } from "@/components/artifacts/steer-card";
import { Composer } from "@/components/composer";
import { useEnterSubmits } from "@/components/enter-submits";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { dockStateKey } from "@/components/dock-state-key";
import { QueuedSteersBody, type QueuedSteerLine } from "@/components/queued-steers";
import { DictationBar, finishDictation, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { JobsContext } from "@/components/jobs-context";
import { StatsBar } from "@/components/stats-bar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	firstSourceTextParts,
	messageAnchorId,
	textPartMessageId,
	kbdEventForAction as kbdEventForChat,
	type LhMessage,
} from "@/src/core";
import { PlanBlock, PlanPopup, latestTree } from "@/components/plan-block";
import { PlanMarginalia, planExists } from "@/components/plan-window";
import { MermaidOverlay, SessionMermaidContext } from "@/components/session-overlay";
import { AbortTurnDialog, type AbortMode } from "@/components/abort-turn-dialog";
import { ArrowRightIcon, CodeIcon, DumbbellIcon, WaypointsIcon } from "lucide-react";
import type { PlanBlockData } from "@/src/core";
import { QuestionDock } from "@/components/question-dock";
import { SessionFind } from "@/components/session-find";
import { SessionMessageNavigation } from "@/components/session-navigation";
import { PracticeDock } from "@/components/practice-dock";
import { ThinkingCard, type PracticeThinkingData } from "@/components/practice-cards";
import { GraphContextCard, type GraphContextData } from "@/components/graph-context-card";
import { TopBar } from "@/components/top-bar";
import type { ArtifactPartProps, JobRecord, Phase3, QuestionAnswerData, QuestionFormDraft, TurnUsage } from "@/src/core";
import type { LhViewMessage } from "@/src/core";
import { PhaseChip, PhaseDivider } from "@/components/phase-divider";
import {
	CompactionCutDivider,
	CompactionMomentDivider,
	type CompactionDividerData,
} from "@/components/compaction-divider";
import { CoverageRing } from "@/components/extraction-coverage";
import {
	activeProblemOf,
	dismissedAnswer,
	findPendingToolCall,
	phaseAt3,
	phaseTimeline,
	teachStepIndex,
	toolQuestionKind,
	questionNeedsReveal,
} from "@/src/core";
import { ReadingThinkingField } from "@/components/reading-thinking";
import { currentUserThinkingOpen, setAllUserThinkingOpen } from "@/components/thinking-block";

/** One width for everything: transcript, cards, and the bottom blob share this column. */
/** Width tokens: the teaching PROSE spans the full session width with a thin px-6 margin */
const COLUMN = "mx-auto w-full max-w-none px-6";
const DOCK = "mx-auto w-full max-w-[46rem] px-4";
// The DOCK container's fixed width (46rem) and the plan marginalia's geometry: the bare diagram sits in the dock band's RIGHT flank
const DOCK_W = 46 * 16;
const MARGIN_GAP = 16;
const MARGIN_MIN_W = 220;
// The dock overlay's gradient band (h-24) — part of the reserved tail.
const GRADIENT_H = 96;
// Fold thresholds: pixel distance from the bottom — position, not velocity.
const COLLAPSE_DIST = 96;
const EXPAND_DIST = 16;

/** Server-sync channel for artifact renderers: the CENTRAL jobs poll in Chat calls syncFromServer() when a background job settles */
export const ChatActionsContext = createContext<{
	chatId: string;
	syncFromServer: () => Promise<void>;
	/** Send a user message into the session (demo error-fix loop, W6). */
	sendText: (text: string) => void;
	/** Opens the model setup dialog: refused job cards deep-link into the same SetupDialog the send interception uses. */
	openSetup: () => void;
} | null>(null);



/** useLayoutEffect that is silent during SSR (client components still render on the server in Next). */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A wake-pipeline steer message: user-role delivery whose metadata marks it as a sub-agent result — rendered as an artifact card, never a bubble. */
/** The quiet system line (custom-message scheme rendering): centered, muted, small */
function SystemLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
	return (
		<div
			data-testid={testId}
			className="flex items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground"
		>
			{children}
		</div>
	);
}

function isSubagentSteer(m: LhViewMessage): boolean {
	return (m.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

/** The teaching session. */
export function Chat({
	chatId,
	title,
	initialMessages,
	initialError,
	initialPrompt,
	initiallyInFlight,
	initiallyCompacting = false,
	kind = "teach",
}: {
	chatId: string;
	title: string;
	initialMessages: LhMessage[];
	/** Memory-only settlement notice supplied on reopening. */
	initialError?: string;
	/** The session kind: practice renders no phase chip (no probe→teach arc applies) and a Practice tag rides the header instead. */
	kind?: "teach" | "practice" | "code";
	initialPrompt?: string;
	/** A teacher turn is running server-side but attached to no client (navigated away mid-turn, returned while in flight). */
	initiallyInFlight?: boolean;
	/** A compaction holds the chat's model gate at mount (navigated away mid-compaction — the registry is live server state */
	initiallyCompacting?: boolean;
	/** slotsConfigured(server record) — the persistent setup CTA keys on it. */
	initialConfigured?: boolean;
}) {
	// Reattach plumbing: the hook holds the settled terminal's callback — a stable ref assigned below, once syncFromServer exists (refs, not closures
	const reattachSettledRef = useRef<() => void>(() => {});

	// THE SESSION HOOK: the app-owned replacement for useChat + the AI-SDK transport.
	const { messages, nativeMessages, contextTokens, send, continueIfOwed, steer, steerQueue, submitAnswer, dismissQuestion, dismissProblem, questionDraft, saveQuestionDraft, setMessages, adoptRecord, status, error, stop, clearError, resumeStream, setReattachSettled } =
		useChatSession({ chatId, initialMessages, initialError, initiallyInFlight });

	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);
	const scrollContextRef = useRef<StickToBottomContext | null>(null);
	const sourceTextParts = useMemo(() => firstSourceTextParts(messages), [messages]);

	// The reattach settled terminal → the sync-and-continue seam (below).
	setReattachSettled(() => reattachSettledRef.current());

	// New chat with a topic: send the first message exactly once (initialPromptOwed — the pure gate, pinned in the test suite).
	const sentInitial = useRef(false);
	useEffect(() => {
		if (!sentInitial.current && initialPromptOwed(initialMessages, initialPrompt)) {
			sentInitial.current = true;
			void send({ type: "text", text: initialPrompt! });
		}
	}, [initialPrompt, initialMessages, send]);

	// A turn running server-side, attached to no live view of ours (navigate away mid-turn, or a wake turn discovered mid-session)
	const [turnInFlight, setTurnInFlight] = useState(initiallyInFlight ?? false);

	// Session title: click-to-rename.
	const [titleText, setTitleText] = useState(title);
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement | null>(null);

	const commitRename = useCallback(
		async (next: string) => {
			setRenaming(false);
			const t = next.trim();
			if (t === "" || t === titleText) return; // empty commit = discard
			try {
				const res = await fetch(`/api/chats/${chatId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: t }),
				});
				if (!res.ok) throw new Error(`rename failed: ${res.status}`);
				setTitleText(t);
				window.dispatchEvent(
					new CustomEvent("lh:chat-renamed", { detail: { id: chatId, title: t } }),
				);
			} catch (err) {
				console.error("rename failed:", err); // keep the old title
			}
		},
		[chatId, titleText],
	);

	// Select-all when edit mode opens: the click means "replace", so the whole title highlights on entry.
	useEffect(() => {
		if (renaming) {
			const el = titleInputRef.current;
			if (el) {
					el.focus();
					el.select();
			}
		}
	}, [renaming]);

	// ── Keyboard seams ── F2 opens the title rename (the chat header owns the editing state).
	useEffect(() => {
		const onRename = () => {
			setTitleDraft(titleText);
			setRenaming(true);
		};
		window.addEventListener("lh:kbd-rename-session", onRename);
		return () => window.removeEventListener("lh:kbd-rename-session", onRename);
	}, [titleText]);

	// The OTHER rename surface: its commit dispatches the same lh:chat-renamed event this header's rename does — if it renamed THIS chat
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			if (id === chatId) setTitleText((prev) => (title !== prev ? title : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [chatId]);

	// The Esc chain's last link: abort the turn.
	const abortInFlightTurn = useCallback(() => {
		if (localStreamRef.current) stop();
		void fetch("/api/activity/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "turn", id: chatId }),
		}).catch(() => {
			/* transient — the turn settles on its own; the record poll adopts */
		});
		// 409 not_running is the benign raced-settle: the stream's finish already settled the view (or the poll fallback adopts) — nothing owed.
	}, [chatId, stop]);
	// ESC-abort guard: the abort chain opens a confirm popup EVERYWHERE (streams and pending questions alike).
	const [abortAsk, setAbortAsk] = useState<AbortMode | null>(null);
	const abortAskRef = useRef<AbortMode | null>(null);
	abortAskRef.current = abortAsk;
	useEffect(() => {
		const onAbort = () => {
			const target = escAbortTarget({
				abortAsk: abortAskRef.current !== null,
				mermaidFocus: mermaidFocusRef.current !== null || figureFocusRef.current !== null,
				planOpen: planOpenRef.current,
				setupOpen: setupOpenRef.current,
				pending: pendingRef.current !== null,
				problem: activeProblemRef.current !== null,
				busy: busyRef.current,
			});
			if (target === "question") setAbortAsk("question");
			else if (target === "problem") setAbortAsk("problem");
			else if (target === "turn") setAbortAsk("turn");
			else if (target === "mermaid") setMermaidFocus(null);
			else if (target === "plan") setPlanOpen(false);
			// setup closes itself; null = nothing to do — both claimed.
		};
		window.addEventListener("lh:kbd-abort-turn", onAbort);
		return () => window.removeEventListener("lh:kbd-abort-turn", onAbort);
	}, []);
	const confirmAbort = useCallback(
		(mode: AbortMode) => {
			setAbortAsk(null);
			if (mode === "turn") {
				abortInFlightTurn();
				return;
			}
			// From a pending question the dismiss is silent: the skipped toolResult lands via the SILENT route, no turn, no wake — the next plain send is the wake.
			const p = pendingRef.current;
			if (p) {
				const question = (p.input as { question?: string } | null)?.question ?? "";
				const reading = readingThinkingRef.current.trim() || undefined;
				clearReadingThinking();
				const answer = dismissedAnswer(toolQuestionKind(p.tool), question);
				void dismissQuestion(
					p.toolCallId,
					reading ? { ...answer, readingThinking: reading } : answer,
				);
				if (busyRef.current) abortInFlightTurn();
				return;
			}
			// The practice discard: ask-style — the silent marker route; the conclude synthesis rides the user's next input.
			const problem = activeProblemRef.current;
			if (problem) {
				void dismissProblem(problem.toolCallId);
				if (busyRef.current) abortInFlightTurn();
			}
		},
		[abortInFlightTurn, dismissQuestion, dismissProblem],
	);
	// Mount continuation: if the stored transcript ends with a fulfilled tool (a job result landed while no client was open), resume the lesson
	const mountContinuation = useRef(false);
	useEffect(() => {
		if (mountContinuation.current) return;
		mountContinuation.current = true;
		if (!turnInFlight) continueIfOwed(initialMessages);
		// mount-only by design (turnInFlight read at initial value)
	}, []);

	const pending = findPendingToolCall(messages);
	// The abort handler reads the pending question from a ref (the window listener is mount-scoped; the value it needs is render-scoped).
	const pendingRef = useRef(pending);
	pendingRef.current = pending;

	// THE ACTIVE PRACTICE PROBLEM: the same dock-ownership rule as a pending question — an active problem replaces the composer.
	const activeProblem = activeProblemOf(nativeMessages);
	const activeProblemRef = useRef(activeProblem);
	activeProblemRef.current = activeProblem;

	const localStream = status === "submitted" || status === "streaming";
	const busy = localStream || turnInFlight;
	const busyRef = useRef(busy);
	busyRef.current = busy;

	// The attach handoff: the moment a resumed stream takes over the rendering — the SDK left "ready", so submitted/streaming means chunks are flowing
	useEffect(() => {
		if (turnInFlight && (status === "submitted" || status === "streaming")) setTurnInFlight(false);
	}, [status, turnInFlight]);

	// Mid-session discovery (jobs poll, handoff watch): a server-side turn exists that none of our views holds
	const turnInFlightRef = useRef(turnInFlight);
	turnInFlightRef.current = turnInFlight;
	const attachToRunningTurn = useCallback(() => {
		setTurnInFlight(true);
		void resumeStream();
	}, [resumeStream]);

	// The practice dock's send: POSTs the thinking against the ACTIVE problem — whether it claims an answer is read from the text by the agent
	const submitThinking = useCallback(
		(text: string) => {
			const problem = activeProblemRef.current;
			if (!problem) return;
			void send({ type: "thinking", problemCallId: problem.toolCallId, text });
		},
		[send],
	);

	// Teach-phase check (W5, vision §2): a pending QUIZ that lands once a plan node is OCCUPIED (phaseAt3 "teach") starts collapsed behind a "Check your
	const requiresReveal = pending !== null && questionNeedsReveal(pending.tool, pending.input, phaseAt3(messages));

	/* The READING-THINKING channel: a draft field for thinking while reading the teaching prose, mounted while a check waits behind its reveal */
	const [readingThinking, setReadingThinking] = useState("");
	const readingThinkingRef = useRef("");

	// ⌘T: set EVERY user thinking row to one state — transcript rows default open, so the first press collapses everything, the second re-expands.
	useEffect(() => {
		const onToggle = () => setAllUserThinkingOpen(!currentUserThinkingOpen());
		window.addEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
		return () => window.removeEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
	}, []);
	const applyReadingThinking = useCallback((v: string) => {
		readingThinkingRef.current = v;
		setReadingThinking(v);
	}, []);
	const clearReadingThinking = useCallback(() => {
		readingThinkingRef.current = "";
		setReadingThinking("");
	}, []);
	const pendingQuestionId = pending?.toolCallId ?? null;
	useEffect(() => {
		// Different calls never share a draft; a failed submission of THIS call restores the reading channel alongside the form's snapshot.
		const reading = pendingQuestionId ? questionDraft(pendingQuestionId)?.readingThinking ?? "" : "";
		readingThinkingRef.current = reading;
		setReadingThinking(reading);
	}, [pendingQuestionId, questionDraft]);

	// The phase at every message (one linear fold): the transcript draws a color-coded dotted divider at each boundary
	const phases = useMemo(() => phaseTimeline(messages), [messages]);

	const [text, setText] = useState("");
	/* The composer's value MIRROR: a dictation flush lands via setState, which a closure waiting through `await finish()` cannot observe in time. */
	const textRef = useRef("");
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		setText(v);
	}, []);
	// No setup flow under the Claude Code bridge: the learner's Claude Code is the model (docs/claude-code-bridge.md).
	const setupOpen = false;
	/** The last explicitly-sent draft (composer send). */
	const draftRef = useRef<string | null>(null);
	// Voice dictation: finals append at the end of the current text (the page owns the separator, dictate-flush style)
	const cycleChatFields = useCallback((): readonly HTMLElement[] => {
		const pick = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
		return [
			...pick('[data-testid="reading-thinking-field"] textarea'),
			...pick('[data-testid="question-dock"] textarea'),
			...pick('[data-testid="practice-dock"] textarea'),
			...pick('[data-testid="composer"] textarea'),
		];
	}, []);
	useFieldCycle(cycleChatFields);
	const dictation = useDictation({
		// Ref-first (see textRef): the join is computed from the mirror so a send resuming after `await finish()` reads the dictated tail.
		append: (t) => applyText(joinDictation(textRef.current, t)),
	});
	/* When a dictation run ends, the bare composer takes focus — the hands are already on the keyboard from the stop. */
	const dictationWasActiveRef = useRef(false);
	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);

	// Jobs never gate the composer (contracts.ts "THE ASYNC PROTOCOL" §4): job tools resolve with an ack mid-turn
	const [compacting, setCompacting] = useState(initiallyCompacting);
	const canSend =
		(text.trim().length > 0 || dictation.active) && !pending && !activeProblem && !compacting;

	/* THE PRACTICE PAUSE: between problems — practice kind, nothing active, nothing in flight */
	const nextReady =
		kind === "practice" &&
		!pending &&
		!activeProblem &&
		!compacting &&
		!busy &&
		nativeMessages.some(
			(m) => (m as { role?: string }).role === "assistant" &&
				Array.isArray((m as { content?: unknown[] }).content) &&
				(m as { content: Array<{ type?: string; name?: string }> }).content.some(
					(b) => b.type === "toolCall" && b.name === "problem",
				),
		);
	const sendNext = useCallback(() => {
		if (!nextReady) return;
		void send({ type: "next" });
	}, [nextReady, send]);

	/* ENTER FROM ANYWHERE: the move-on must not require composer focus. */
	useEnterSubmits(sendNext);

	const syncFromServer = useCallback(async () => {
		const res = await fetch(`/api/chats/${chatId}`);
		if (!res.ok) return;
		const record = (await res.json()) as { messages?: LhMessage[]; turns?: TurnUsage[]; pricing?: unknown; turnError?: string };
		if (Array.isArray(record.turns)) setTurns(record.turns);
		setPricing(record.pricing);
		if (!Array.isArray(record.messages)) return;
		setMessages(record.messages, record.turnError);
		// The continuation seam (contracts.ts protocol §4): a job result landing in the record leaves the agent owing a continuation
		continueIfOwed(record.messages);
	}, [chatId, setMessages, continueIfOwed]);

	// The settled terminal's other half: the transport resolved turn-settled — no turn running, the record is current.
	reattachSettledRef.current = () => {
		setTurnInFlight(false);
		void syncFromServer();
	};

	// ── Append-only record adoption ── Content delivered into the record server-side — sub-agent artifacts, abort notes
	const adoptAppendOnly = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { messages?: LhMessage[] };
			if (!Array.isArray(record.messages)) return;
			adoptRecord(record.messages);
		} catch {
			/* transient — the idle full sync is the net */
		}
	}, [chatId, adoptRecord]);

	// Turn-start window: the server inserts claimed steers right after our outgoing message, BEFORE the stream produces anything — so a bounded
	const turnStartStatusRef = useRef(status);
	// The window must survive the submitted→streaming flip (the stream starts in well under 400ms), so the timers are guarded by this ref
	const adoptionWindowOpenRef = useRef(false);
	const turnStartTimerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
	useEffect(() => {
		const was = turnStartStatusRef.current;
		turnStartStatusRef.current = status;
		if (was === "submitted" || status !== "submitted") return;
		// A turn just started (status flipped ready → submitted): open the bounded adoption window.
		adoptionWindowOpenRef.current = true;
		const timers = [400, 1000, 2000].map((ms) =>
			setTimeout(() => {
				if (adoptionWindowOpenRef.current) {
					void adoptAppendOnly();
				}
			}, ms),
		);
		// Deliberately no cleanup here: this effect re-runs on every status flip, which would cancel the window at submitted→streaming.
		timers.forEach((t) => {
			turnStartTimerRefs.current.push(t);
		});
	}, [status, adoptAppendOnly]);
	useEffect(() => {
		const timers = turnStartTimerRefs;
		return () => {
			adoptionWindowOpenRef.current = false;
			timers.current.forEach(clearTimeout);
			timers.current = [];
		};
	}, []);

	// The live plan popup: opened by any transcript plan block, the top-bar plan chip, and the dock band's marginalia.
	const [planOpen, setPlanOpen] = useState(false);
	// Real plan presence — gates the marginalia's clickable flank.
	const hasPlan = useMemo(() => planExists(messages), [messages]);
	// The coverage ring's refresh chain (extraction-UX redesign): bumped at turn settle — the moment this session's uncovered mass changes.
	const [coverageTick, setCoverageTick] = useState(0);
	// The mermaid focus: md-blocks' expand button registers the chart source here; the overlay (and the plan popup) mount INSIDE the session-area div
	const [mermaidFocus, setMermaidFocus] = useState<string | null>(null);
	// Figure focus: the figure card's fullscreen button — same overlay shell as mermaid
	const [figureFocus, setFigureFocus] = useState<{ svg: string; inverted: boolean } | null>(null);

	// Overlay mirrors for the layered-Esc gate: the lh:kbd-abort-turn handler reads these at EVENT time — declared here beside their states
	const mermaidFocusRef = useRef(mermaidFocus);
	mermaidFocusRef.current = mermaidFocus;
	// The figure focus rides the mermaid layer in the Esc gate — the same overlay class (session-scoped diagram focus
	const figureFocusRef = useRef(figureFocus);
	figureFocusRef.current = figureFocus;
	const planOpenRef = useRef(planOpen);
	planOpenRef.current = planOpen;
	const setupOpenRef = useRef(setupOpen);
	setupOpenRef.current = setupOpen;
	// The session's live plan (drives the top-bar chip; the marginalia derives its own from the same transcript).
	const planTree = useMemo(() => latestTree(messages), [messages]);

	// ── Session usage ── The money channel: the record's turns log and read-time server Pi pricing projection.
	const [turns, setTurns] = useState<TurnUsage[]>([]);
	const [pricing, setPricing] = useState<unknown>();
	// The per-chat model control state (model-picker writes via PUT; the record is the source of truth, lifted here so the stats bar re-renders).
	const [dockReserve, setDockReserve] = useState(208);
	const syncTurns = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { turns?: TurnUsage[]; pricing?: unknown };
			if (Array.isArray(record.turns)) setTurns(record.turns);
			setPricing(record.pricing);
		} catch {
			// transient blip: stats stay on the last known figures
		}
	}, [chatId]);
	useEffect(() => {
		void syncTurns();
	}, [syncTurns]);
	// After the learner's own turn ends the log has a fresh entry — and the Post-turn settle: our own stream just ended.
	const prevStatusRef = useRef(status);
	useEffect(() => {
		const transitioned = prevStatusRef.current !== "ready" && status === "ready";
		// Every path (the old early-return skipped this on the transition branch — the re-fire-on-dep-churn wart, fixed S3).
		prevStatusRef.current = status;
		if (!transitioned) return;
		// immediate: turns-only refetch — the stats bar updates even while the server's persist/endTurn lags the client by milliseconds
		void syncTurns();
		// The coverage ring re-reads at turn settle too; the ring's own running-poll handles runs.
		setCoverageTick((t) => t + 1);
		// CANONIZATION: turn-settled for OUR OWN turn arrives while the stream is still open (endTurn emits from onFinish before the response terminates
		if (settleAnnouncedRef.current) {
			settleAnnouncedRef.current = false;
			void syncFromServer();
		}
		// (The extraction-discovery nudges that lived here died at S5: the pipeline announces every phase on the events channel.)
	}, [status, syncTurns, syncFromServer]);

	// A stream that died MID-FLIGHT (network): the runner decoupled the turn from its view, so the server turn runs ON behind the error banner
	const prevErrorStatusRef = useRef(status);
	useEffect(() => {
		const was = prevErrorStatusRef.current;
		prevErrorStatusRef.current = status;
		if (was === "error" || status !== "error") return;
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${chatId}`);
				if (!res.ok || cancelled) return;
				const record = (await res.json()) as { turnInFlight?: boolean };
				if (cancelled) return;
				if (record.turnInFlight === true) setTurnInFlight(true);
				else void syncFromServer();
			} catch {
				/* transient — the banner stands; the next send's merge-retry heals */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [status, chatId, syncFromServer]);

	// ── Central job observability (contracts.ts "THE ASYNC PROTOCOL" §4) ── ONE fetch of /api/jobs drives every job surface (transcript dispatch cards
	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const localStreamRef = useRef(false);
	localStreamRef.current = localStream;
	const jobStatusRef = useRef<Map<string, string>>(new Map());
	// A settle seen during a busy turn — the sync is owed, not dropped.
	const pendingSyncRef = useRef(false);
	// (The dispatch nudge effect that lived here — refreshActivity per new dispatch tool part — died at S5
	const firstFetchRef = useRef(true);
	// The trailing debounce for jobs-changed announcements (one timer)
	const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const fetchJobsRef = useRef<() => void>(() => {});
	const fetchJobs = useCallback(async () => {
		try {
			const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);
			if (!res.ok) return;
			const data = (await res.json()) as { jobs?: JobRecord[]; turnInFlight?: boolean };
			const list = data.jobs ?? [];
			for (const j of list) {
				const prev = jobStatusRef.current.get(j.id);
				if (prev === "running" && j.status !== "running") {
					// A settle — the blob leaves the dock via the store's jobs-changed announce at this very write (S5); this handler owns the RECORD.
					if (localStreamRef.current || data.turnInFlight === true) {
						pendingSyncRef.current = true;
						void adoptAppendOnly();
					} else {
						void syncFromServer();
					}
				}
				jobStatusRef.current.set(j.id, j.status);
			}
			firstFetchRef.current = false;
			if (
				pendingSyncRef.current &&
				!localStreamRef.current &&
				data.turnInFlight !== true
			) {
				pendingSyncRef.current = false;
				void syncFromServer();
			}
			setJobs(list);
			// (Wake-turn adoption that lived here — the turnInFlight attach line — died at S3: turn-started on the events channel owns discovery now.
		} catch {
			/* transient fetch failure — the next jobs-changed announcement re-fetches */
		}
	}, [chatId, syncFromServer, adoptAppendOnly]);
	fetchJobsRef.current = () => void fetchJobs();
	// Mount + chat switch: the IMMEDIATE (non-debounced) initial read.
	useEffect(() => {
		firstFetchRef.current = jobStatusRef.current.size === 0;
		void fetchJobs();
	}, [fetchJobs]); // identity changes exactly on chatId
	useServerEvent("jobs-changed", (p) => {
		if (p.chatId != null && p.chatId !== chatId) return; // ours or unattributed
		if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		fetchDebounceRef.current = setTimeout(() => {
			fetchDebounceRef.current = undefined;
			fetchJobsRef.current();
		}, 250);
	});
	// Reconnect catch-up: events missed while the channel was down.
	useServerResync(() => fetchJobsRef.current());
	useEffect(
		() => () => {
			if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		},
		[],
	);

	// ── Server-initiated turn discovery ── Every turn THIS chat runs is announced on the events channel — the probe→teach handoff, a job wake
	const statusRef = useRef(status);
	statusRef.current = status;
	/** Fix B: turn-settled arrived for OUR OWN turn — the record is durable (endTurn fires only after persistTurn) */
	const settleAnnouncedRef = useRef(false);
	useServerEvent("turn-started", (p) => {
		// Known non-issue: beginTurn emits before registerTurn in the same synchronous request flow
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) return; // our OWN turn — the 409-race guard
		if (turnInFlightRef.current) return; // already attached
		attachToRunningTurn();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) {
			// Our own [DONE] path owns the BUSY settle — but not a no-op: the event is the record-durable guarantee (endTurn fires only after persistTurn)
			settleAnnouncedRef.current = true;
			return;
		}
		if (turnInFlightRef.current) {
			// The attached stream's terminal frame owns the normal settle — syncing HERE would swap a stale snapshot mid-stream (the continuation-coalescing law
			if (statusRef.current === "error") {
				setTurnInFlight(false);
				clearError();
				void syncFromServer();
			}
			return;
		}
		// Fully idle — a turn we never saw (every window missed): adopt now.
		void syncFromServer();
	});
	useServerEvent("compaction-changed", (p) => {
		// The settle-kick's background summary: while it runs, sends gate (the next turn's server-side ensureCompacted awaits it anyway
		if (p.chatId !== chatId) return;
		setCompacting(p.running);
	});
	useServerEvent("record-changed", (p) => {
		// The silent dismissal write: no turn ever ran, so only the record moved.
		if (p.chatId !== chatId) return;
		if (localStreamRef.current || turnInFlightRef.current) return;
		void syncFromServer();
	});

	const onSend = () => {
		if (pending || compacting) return;
		/* FINISH DICTATION FIRST: a learner who keeps talking right through Enter must not lose the tail — stop the run */
		if (!dictation.active) {
			doSteerOrSend();
			return;
		}
		void dictation.finish().then(doSteerOrSend);
	};
	const doSend = () => {
		if (busy || pending || compacting) return;
		const t = textRef.current.trim();
		if (!t) return;
		draftRef.current = t; // the refusal flow's preserve-and-replay seam
		applyText("");
		void send({ type: "text", text: t });
	};

	/* STEER VS SEND: a send while a turn runs steers it — the quiet queue + the live agent's steering rail */
	const doSteerOrSend = () => {
		if (pending || compacting) return;
		const t = textRef.current.trim();
		if (!t) return;
		if (busy) {
			applyText("");
			void steer(t);
			return;
		}
		doSend();
	};

	return (
		<ChatActionsContext.Provider
			value={{
				chatId,
				syncFromServer,
				sendText: (t: string) => {
					void send({ type: "text", text: t });
				},
				openSetup: () => {},
			}}
		>
		<SessionMermaidContext.Provider
			value={{
				openMermaid: setMermaidFocus,
				openFigure: (svg, inverted) => setFigureFocus({ svg, inverted }),
			}}
		>
		<JobsContext.Provider value={jobs}>
		{/* The session surface: the transcript column (header + scroller) and the plan-tree panel as full-height SIBLINGS… */}
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* The top bar is its own block: in flow above the scroller on the plain page background — no gradient. */}
				<TopBar
					// While renaming the bar is NOT a drag surface: app-region:drag would eat the mousedown, so click-to-escape (below) could never fire.
					drag={!renaming}
					onMouseDown={(e) => {
						// Escape hitbox: any mousedown outside the input itself blurs it, running the existing onBlur commit path.
						if (renaming && e.target !== titleInputRef.current) titleInputRef.current?.blur();
					}}
				>
					{renaming ? (
						<>
							<input
								ref={titleInputRef}
								value={titleDraft}
								onChange={(e) => setTitleDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void commitRename(titleDraft);
									// stopPropagation claims the Esc: closing rename must not also abort a turn.
									else if (e.key === "Escape") {
										e.stopPropagation();
										setRenaming(false);
									}
								}}
								onBlur={() => void commitRename(titleDraft)}
								spellCheck={false}
								aria-label="Session title"
								title="Rename this session"
								className="lh-no-drag min-w-[8ch] max-w-[70%] shrink-0 bg-transparent font-title text-3xl tracking-tight caret-current outline-none [field-sizing:content]"
							/>
							{/* flex-1 spacer during rename too, so the chips stay at the right edge; clicks here commit via the header mousedown handler. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
						</>
					) : (
					<>
						<Hint
							// F2 renames (registry) — surfaced on the hover.
							label="Rename session"
							action="rename-session"
							side="bottom"
						>
<button
							type="button"
														onClick={() => {
								setTitleDraft(titleText);
								setRenaming(true);
							}}
							className="lh-no-drag -mx-1.5 min-w-4 shrink cursor-text truncate rounded-md px-1.5 text-left font-title text-3xl tracking-tight transition-colors hover:bg-accent"
						>
							{titleText}
							</button>
						</Hint>
							{/* flex-1 spacer: keeps the chips at the right edge AND stays a drag surface (no carve-out) — the freed bar is grippable. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
					</>
					)}
					{/* The plan chip: session-level structure beside the phase chip — access to the full-DAG popup at every width… */}
					{planTree && (
						<Hint label="Open the full plan" side="bottom">
<button
							type="button"
							data-testid="plan-chip"
							onClick={(e) => {
								blurAfterPointerClick(e);
								setPlanOpen(true);
							}}
							className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
						>
							<WaypointsIcon className="size-3.5 text-primary" aria-hidden />
							Plan
						</button>
</Hint>
					)}
					{/* The extraction ring: fills with uncovered vs the chunk threshold, pulses while a run is in flight, vanishes when the graph is off. */}
					{/* Practice: the coverage ring hides — practice never extracts, so an ever-filling ring with no run behind it would lie. */}
					{kind !== "practice" && <CoverageRing chatId={chatId} refreshKey={coverageTick} />}
					{/* Practice sessions: no phase arc — a quiet Practice tag instead of the phase chip. */}
					{kind === "practice" ? (
						<span
							data-testid="phase-chip"
							data-phase="practice"
							aria-hidden="true"
							className="pointer-events-none flex shrink-0 select-none items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
						>
							<DumbbellIcon className="size-3" />
							Practice
						</span>
					) : kind === "code" ? (
						// Coding chats: no phase arc either — a Code tag.
						<span
							data-testid="phase-chip"
							data-phase="code"
							aria-hidden="true"
							className="pointer-events-none flex shrink-0 select-none items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
						>
							<CodeIcon className="size-3" />
							Code
						</span>
					) : (
						<PhaseChip phase={phases.at(-1) ?? "probe"} />
					)}
				</TopBar>

				<SessionFind scopeRef={sessionFindScopeRef} scrollContextRef={scrollContextRef} />
				<div ref={sessionFindScopeRef} className="relative flex min-h-0 flex-1">
				<Conversation className="h-full min-w-0 flex-1" initial="instant" contextRef={scrollContextRef}>
					<SessionMessageNavigation />
					<ConversationContent className="min-h-full gap-0 p-0">
						<div data-session-find-root="" className={`${COLUMN} flex flex-1 flex-col gap-4 pt-4`}>
							{messages.length === 0 && !busy && (
								<ConversationEmptyState
									title="New session"
									description="The teacher will open by probing what you already know."
								/>
							)}

							{messages.map((m, mi) =>
								m.role === "user" && isSubagentSteer(m) ? (
									// Sub-agent delivery (wake-pipeline steer): NO message bubble — the artifact card sits in the transcript column directly
									<SubagentSteerCard key={m.id || `m-${mi}`} message={m} />
								) : m.role === "user" && m.parts.some((p) => p.type === "data-probe-handoff") ? (
								// The probe→teach handoff wake (custom-message scheme): the PLANNING DIVIDER IS the seam.
								<PhaseDivider key={m.id || `m-${mi}`} phase="plan" />
							) : m.role === "user" && m.parts.length > 0 && m.parts.every((p) => p.type.startsWith("data-")) ? (
								// Marker cards: user-side scaffolding — the graph-context pick, the practice thinking trace — render as cards in the transcript column directly
								<Fragment key={m.id || `m-${mi}`}>
									{m.parts.map((part, pi) => {
										switch (part.type) {
											case "data-graph-context":
												return <GraphContextCard key={pi} data={part.data as GraphContextData} />;
											case "data-compaction":
												return <CompactionMomentDivider key={pi} data={part.data as CompactionDividerData} />;
											case "data-compaction-cut":
												return <CompactionCutDivider key={pi} data={part.data as CompactionDividerData} />;
											case "data-practice-thinking":
												return <ThinkingCard key={pi} data={part.data as PracticeThinkingData} />;
											case "data-practice-next":
												// The learner's move-on signal: a compact centered mono-caps line — chrome, the dismissal register.
												return (
													<div
														key={pi}
														data-testid="practice-next-line"
														className="my-4 flex items-center justify-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground"
													>
														<ArrowRightIcon className="size-3" />
														Next problem
													</div>
												);
											default:
												return null;
										}
									})}
								</Fragment>
							) : (
									<Fragment key={m.id || `m-${mi}`}>
									{/* THE INFERRED TEACH SEAM: teaching begins where the FIRST nodeId-tagged quiz is posed — the fold (phaseTimeline… */}
									{m.role === "assistant" &&
									mi > 0 &&
									phases[mi] === "teach" &&
									phases[mi - 1] !== "teach" &&
									teachStepIndex(m.parts) === -1 ? (
										<PhaseDivider key={`teach-${m.id || `m-${mi}`}`} phase="teach" />
									) : null}
									{m.role === "user" ? (
										/* THE DOCUMENT ROW: no right-aligned bubble — the transcript reads as a document. */
											<div
										data-testid="user-message"
										/* THE DOCUMENT, ALL-IN: no chat side — the user message is a full-width card-color BAND, the IDENTICAL geometry as the thinking rows: 5px band padding */
										className="my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-1 pl-[14px] pr-4 font-ui text-xs"
									>
												{/* The rail GROUPS: the YOU heading sits INSIDE the rail, same mono-xs register and same 1ch rail as the thinking rows — one quote geometry. */}
												<div className="font-medium uppercase tracking-wide text-muted-foreground">You</div>
												<div className="lh-prose whitespace-pre-wrap text-foreground">
													{m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")}
												</div>
											</div>
									) : (
									<Message from="assistant" className="max-w-full">
									<MessageContent className="w-full">
											{m.parts.map((part, pi) => {
												const isLastPart = mi === messages.length - 1 && pi === m.parts.length - 1;
												// The step boundary where teaching begins: when the teach flip happens in a LATER step, its PhaseDivider replaces this boundary's plain hairline.
												const teachBoundary =
													m.role === "assistant" &&
													mi > 0 &&
													phases[mi] === "teach" &&
													phases[mi - 1] !== "teach" &&
													teachStepIndex(m.parts) === pi;
												// A tool call that errored BACK TO THE AGENT (validation failure, malformed args) is invisible work — the agent reads the error and retries.
												if (
													part.state === "output-error" &&
													part.type.startsWith("tool-") &&
													part.errorText !== "Operation aborted"
												) {
													return (
														<SystemLine key={`retry-${pi}`} testId="tool-retry">
															Retrying…
														</SystemLine>
													);
												}
												switch (part.type) {
													case "text": {
														const sourceId = textPartMessageId(part.id);
														const anchor = sourceId && sourceTextParts.get(sourceId) === part.id ? messageAnchorId(sourceId) : undefined;
														return (
															<div key={part.id || pi} id={anchor} data-source-message-id={sourceId ?? undefined} className="lh-source-passage">
																<MessageResponse>{part.text}</MessageResponse>
															</div>
														);
													}
													case "reasoning":
														return (
															<Reasoning key={pi} isStreaming={status === "streaming" && isLastPart} className="mb-2">
																<ReasoningTrigger />
																<ReasoningContent>{part.text ?? ""}</ReasoningContent>
															</Reasoning>
														);
													case "step-start":
														if (teachBoundary)
															return <PhaseDivider key={`teach-step-${pi}`} phase="teach" />;
														return pi > 0 ? <Separator key={pi} className="my-3" /> : null;
													case "data-plan-block":
														// The plan in the chat: a frozen snapshot block — rendered as carried, never re-derived.
														return (
															<PlanBlock
																key={pi}
																data={part.data as PlanBlockData}
																onOpen={() => setPlanOpen(true)}
															/>
														);
													case "tool-quiz":
													case "tool-probe":
													case "tool-ask_user_question":
													case "tool-explain":
													case "tool-recall": {
														// Pending/streaming questions live in the dock, not the transcript; answered ones render as graded records.
														if (part.state === "output-available") {
															return (
																<AnsweredCard key={pi} answer={part.output as QuestionAnswerData} input={part.input} />
															);
														}
														return null;
													}
													default: {
														// A tool call being WRITTEN: input-streaming spans the whole execution, and the live card — spinner + shimmered activity label
														if (part.type.startsWith("tool-") && part.state === "input-streaming") {
															return <LiveToolCard key={pi} part={part as ArtifactPartProps["part"]} />;
														}
														// Artifact extension point (contracts.ts): job parts and future artifacts render via the registry — add renderers there, not here.
														if (part.type.startsWith("tool-")) {
															const Renderer = artifactRenderers[part.type.slice("tool-".length)];
															if (Renderer) return <Renderer key={pi} part={part as ArtifactPartProps["part"]} />;
														}
														return null;
													}
												}
											})}
										</MessageContent>
									</Message>
									)}
								</Fragment>
							))}

							{/* THE placeholder, ACTION-gated: spinner + shimmered Thinking… from the instant of any action that produces tokens — send, answer, session start… */}
							{/* Compaction: the same register as the thinking placeholder — a visible session-wide state while the summarizer holds the model gate. */}
							{compacting && (
								<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<BrailleSpinner label="Compacting context" />
									<Shimmer duration={1}>COMPACTING CONTEXT…</Shimmer>
								</span>
							)}
							{(status === "submitted" || turnInFlight) && (
								<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<BrailleSpinner label="Thinking" />
									<Shimmer duration={1}>
										THINKING…
									</Shimmer>
								</span>
							)}
							{error && (
								<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
									Something went wrong: {error.message}
								</div>
							)}
						</div>

						{/* The dock's reserved tail (DockOverlay reports its height): keeps at-rest transcript content scrolling fully clear of the overlay… */}
						<div aria-hidden data-testid="dock-spacer" style={{ height: dockReserve }} />
				</ConversationContent>
				{/* The dock: an overlay sibling of the scroller (the use-stick-to-bottom pattern). */}
				<DockOverlay
					pending={pending}
					initialQuestionDraft={pending ? questionDraft(pending.toolCallId)?.form : undefined}
					onSaveQuestionDraft={(form) => { if (pending) saveQuestionDraft(pending.toolCallId, { form }); }}
					practice={activeProblem}
					compactionRunning={compacting}
					onSubmitThinking={submitThinking}
					chatId={chatId}
					plan={hasPlan ? <PlanMarginalia messages={messages} /> : undefined}
					onOpenPlan={() => setPlanOpen(true)}
					requiresReveal={requiresReveal}
					readingThinking={readingThinking}
					onReadingThinking={applyReadingThinking}
					phase={phases.at(-1) ?? "probe"}
					turns={turns}
					contextTokens={contextTokens}
					pricing={pricing}
					onReserve={setDockReserve}
					dictationSlot={<DictationBar dictation={dictation} />}
					dictationCancel={dictation.cancel}
					queuedSteers={visibleQueuedSteers(steerQueue, nativeMessages)}
					composer={
						<Composer
							// Stop aborts ANY in-flight turn: the square renders while a reattached/wake turn runs too — the abort channel kills it server-side
							busy={busy}
							value={text}
							onChange={applyText}
							inputRef={composerInputRef}
							onSend={onSend}
							onStop={abortInFlightTurn}
							canSend={canSend}
							onEscape={dictation.active ? dictation.cancel : undefined}
							// The pause affordance: the placeholder IS the hint — empty state, exactly where Enter-on-empty applies.
							nextProblem={nextReady}
							onNext={sendNext}
							placeholder={nextReady ? "Ask anything, or press Enter for the next one." : undefined}
						/>
					}
					onSubmitAnswer={(output) => {
						if (!pending) return;
						// THE ANSWER IS THE QUESTION CALL'S TOOL RESULT: one input event, one turn
						saveQuestionDraft(pending.toolCallId, { readingThinking: readingThinkingRef.current });
						const reading = readingThinkingRef.current.trim() || undefined;
						// The pending-id effect clears this only when the question actually leaves.
						submitAnswer(pending.tool, pending.toolCallId, reading ? { ...output, readingThinking: reading } : output);
					}}
				/>
				</Conversation>

				{/* The session-scoped focuses: mounted INSIDE the session area — absolute inset-0 siblings of the scroller, so they own the area below the drag bar… */}
				{mermaidFocus !== null && (
					<MermaidOverlay chart={mermaidFocus} onClose={() => setMermaidFocus(null)} />
				)}
				{figureFocus !== null && (
					<MermaidOverlay
						svg={figureFocus.svg}
						inverted={figureFocus.inverted}
						onClose={() => setFigureFocus(null)}
					/>
				)}
				{planOpen && <PlanPopup messages={messages} onClose={() => setPlanOpen(false)} />}
				<AbortTurnDialog mode={abortAsk} onClose={() => setAbortAsk(null)} onConfirm={confirmAbort} busy={busy} />
				</div>
				<ClaudeTerminal chatId={chatId} />
			</div>
		</div>
		</JobsContext.Provider>
		</SessionMermaidContext.Provider>
		</ChatActionsContext.Provider>
	);
}

/** The floating blob: ONE persistent shell, OVERLAID at the bottom of the column (absolute — a sibling of the scroller, the use-stick-to-bottom pattern */
/** How a teach-phase question arrives: collapsed behind the reveal button when it follows the composer — the learner reads the teaching first */
/** The layered-Esc ruling: an open overlay claims Esc — closing itself — before the abort chain may open its confirm. */
type EscAbortTarget = "mermaid" | "plan" | "setup" | "question" | "problem" | "turn" | null;
	/** Does the ?prompt topic still owe its first send? */
function initialPromptOwed(messages: readonly { role: string }[], prompt: string | undefined): boolean {
	if (!prompt) return false;
	return !messages.some((m) => m.role === "user" || m.role === "assistant");
}

function escAbortTarget(s: {
	abortAsk: boolean;
	mermaidFocus: boolean;
	planOpen: boolean;
	setupOpen: boolean;
	pending: boolean;
	/** An active practice problem: Esc opens the discard confirm — below a pending question (the two never coexist, but the layering stays strict) */
	problem: boolean;
	busy: boolean;
}): EscAbortTarget {
	if (s.abortAsk) return null; // the popup's own Esc — claimed by the dialog
	if (s.mermaidFocus) return "mermaid";
	if (s.planOpen) return "plan";
	if (s.setupOpen) return "setup";
	if (s.pending) return "question";
	if (s.problem) return "problem";
	if (s.busy) return "turn";
	return null;
}

function revealArrival(wasQuestion: boolean): { expanded: boolean; revealed: boolean } {
	return wasQuestion ? { expanded: true, revealed: true } : { expanded: false, revealed: false };
}

/** A PROBE question's arrival state: open iff the learner is at the bottom following along; scrolled up in history → arrive as the collapsed bar. */
function probeArrivalExpanded(isAtBottom: boolean): boolean {
	return isAtBottom;
}

/** The geometry-mute's growth rule: a reserve GROWTH while a question is pending is the dock stretching (the dictation flush landing many lines at once) */
function shouldStampGeometryMute(nextH: number, prevH: number, pending: boolean): boolean {
	return pending && nextH > prevH + 1;
}

function DockOverlay({
	pending,
	initialQuestionDraft,
	onSaveQuestionDraft,
	practice,
	compactionRunning,
	onSubmitThinking,
	requiresReveal,
	readingThinking,
	onReadingThinking,
	phase,
	turns,
	contextTokens,
	pricing,
	composer,
	onSubmitAnswer,
	chatId,
	onReserve,
	plan,
	onOpenPlan,
	dictationSlot,
	dictationCancel,
	setupCta,
	queuedSteers,
}: {
	pending: ReturnType<typeof findPendingToolCall>;
	initialQuestionDraft?: QuestionFormDraft;
	onSaveQuestionDraft: (draft: QuestionFormDraft) => void;
	/** Compaction running for this chat — the docks' submit affordance gate (the server's registry is the real one). */
	compactionRunning: boolean;
	/** The ACTIVE practice problem: {toolCallId, input} — dock ownership exactly like a pending question (the composer is replaced) */
	practice: { toolCallId: string; input: unknown } | null;
	/** (commit, text) — the practice dock's two submit lanes. */
	onSubmitThinking: (text: string) => void;
	/** Teach-phase pending question: arrives collapsed behind the reveal button (W5). */
	requiresReveal: boolean;
	/** The reading-thinking draft — owned by ChatView so the submit + dismissal seams (outside this overlay) can merge it. */
	readingThinking: string;
	onReadingThinking: (v: string) => void;
	/** Session phase at the pending question — scales the thinking field. */
	phase: Phase3;
	/** The session's usage log — the stats bar beneath the composer folds it. */
	turns: TurnUsage[];
	contextTokens: number | null;
	pricing?: unknown;
	composer: React.ReactNode;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
	/** The model control's pass-through (the stats bar hosts it). */
	chatId: string;
	/** Reports the dock's settled height (block + gradient) — ChatView's dockReserve state feeds the transcript's spacer from it. */
	onReserve: (h: number) => void;
	/** The plan marginalia's content (the bare diagram) — rendered only while a question owns the band. */
	plan?: React.ReactNode;
	/** Opens the full-DAG popup (the marginalia + chip share it). */
	onOpenPlan: () => void;
	/** The dictation strip: rendered in the stats bar's middle slot — the mic button + live meter (components/dictation.tsx). */
	dictationSlot?: React.ReactNode;
	/** Esc in a pending question's field stops dictation (the strip is the stats bar's; the stop belongs to the page-owned hook, threaded down). */
	dictationCancel?: () => void;
	/** The queued-steer indicator's lines: already filtered by visibleQueuedSteers — only undrained steers. */
	queuedSteers: QueuedSteerLine[];
	/** The persistent setup CTA: the same pill home and /chat/new carry, above the composer while slots are unset. */
	setupCta?: React.ReactNode;
}) {
	const { isAtBottom, scrollToBottom, scrollRef } = useStickToBottomContext();
	// Render-fresh bottom state: the arrival block below reads it DURING RENDER — the same value the after-paint effect used to read a frame too late.
	const atBottomRef = useRef(isAtBottom);
	atBottomRef.current = isAtBottom;
	// Teach-phase mount (session reload with a pending check): the dock starts as the collapsed invitation too — the check must not pop open on reload.
	const [expanded, setExpanded] = useState(!requiresReveal);
	// Reveal state (W5): false until the learner clicks the invitation.
	const [revealed, setRevealed] = useState(false);
	const revealPending = requiresReveal && !revealed;

	const pendingId = pending?.toolCallId ?? null;
	const initialPendingRef = useRef(pendingId);

	// Teach-question ARRIVAL state, applied during render — BEFORE the first paint.
	const prevPendingIdRef = useRef(pendingId);
	if (pendingId !== prevPendingIdRef.current) {
		const wasQuestion = prevPendingIdRef.current !== null;
		prevPendingIdRef.current = pendingId;
		if (pendingId && requiresReveal) {
			const arrival = revealArrival(wasQuestion);
			setExpanded(arrival.expanded);
			setRevealed(arrival.revealed);
		} else if (pendingId) {
			// Probe arrival: open iff following at the bottom.
			setExpanded(probeArrivalExpanded(atBottomRef.current));
		}
	}

	// New question MID-SESSION: the open/closed state itself is decided DURING RENDER above
	useEffect(() => {
		if (!pendingId || pendingId === initialPendingRef.current) return;
		if (!requiresReveal && atBottomRef.current) void suppressFoldDuringReveal();
		// fire only when a NEW question lands
	}, [pendingId]);

	// ── Fold machine ── The dock is an overlay: folding is visual-only and scroll geometry never moves, so the thresholds can hug the bottom.
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	// Dock ownership (the fold machine, the reserve immunity, the arrival states): a pending question OR an active practice problem
	const pendingRef = useRef(!!pending || !!practice);
	pendingRef.current = !!pending || !!practice;
	const requiresRevealRef = useRef(requiresReveal);
	requiresRevealRef.current = requiresReveal;
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;

	// The plan marginalia's flank width: from the DOCK container's right edge to the block's right edge — the bare diagram's canvas.
	const [flankW, setFlankW] = useState(0);
	const flankWRef = useRef(0);
	// Part A of the same round (the resize mute): any block size change stamps this — the fold machine ignores scroll events for a beat after
	const geometryAtRef = useRef(0);
	useIsoLayoutEffect(() => {
		const block = blockRef.current;
		if (!block) return;
		const measure = () => {
			const next = Math.round(block.offsetWidth / 2 - DOCK_W / 2 - 2 * MARGIN_GAP);
			if (Math.abs(next - flankWRef.current) > 1) {
				flankWRef.current = next;
				setFlankW(next);
				geometryAtRef.current = Date.now();
			}
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(block);
		return () => ro.disconnect();
	}, []);

	// The overlay must not paint over the scroller's scrollbar: the scroller reserves symmetric gutters (scrollbar-gutter: stable both-edges)
	const [sbInset, setSbInset] = useState(0);
	const [dockMaxH, setDockMaxH] = useState<number | null>(null);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () => {
			setSbInset(Math.round((el.offsetWidth - el.clientWidth) / 2));
			setDockMaxH(Math.max(el.clientHeight - 32, 160));
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [scrollRef]);

	// GROWTH MUTE: during a live turn the transcript content grows and stick-to-bottom chases it
	const growthAtRef = useRef(0);
	useEffect(() => {
		const el = scrollRef.current;
		const content = el?.firstElementChild as HTMLElement | null | undefined;
		if (!el || !content) return;
		let prevH = content.getBoundingClientRect().height;
		const ro = new ResizeObserver(() => {
			const h = content.getBoundingClientRect().height;
			if (h > prevH + 0.5) growthAtRef.current = Date.now();
			prevH = Math.max(prevH, h);
		});
		ro.observe(content);
		return () => ro.disconnect();
	}, [scrollRef]);

	// Wheel over the dock must still scroll the transcript: the overlay is a SIBLING of the scroller
	useEffect(() => {
		const root = blockRef.current;
		const el = scrollRef.current;
		if (!root || !el) return;
		const canScroll = (n: HTMLElement, dir: number) => {
			if (n.scrollHeight - n.clientHeight < 2) return false; // not scrollable
			return dir < 0 ? n.scrollTop > 0 : n.scrollTop < n.scrollHeight - n.clientHeight - 0.5;
		};
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY === 0) return;
			for (let n = e.target as HTMLElement | null; n && n !== root; n = n.parentElement) {
				if (n instanceof HTMLElement && canScroll(n, e.deltaY)) return; // native
			}
			e.preventDefault();
			el.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
		};
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	}, [scrollRef]);

	// ── The reserve: the spacer's height, reported upward ── Grows immediately (typing, new variants).
	const reserveRef = useRef(0);
	const blockRef = useRef<HTMLDivElement>(null);
	const offer = (blockH: number) => {
		const next = blockH + GRADIENT_H;
		if (next <= reserveRef.current + 0.5 && pendingRef.current) return; // fold immunity
		// Reserve GROWTH is the phantom-scroll SOURCE: the spacer's height lands in this commit, the smooth catch-up lags it by the growth amount
		if (shouldStampGeometryMute(next, reserveRef.current, pendingRef.current)) geometryAtRef.current = Date.now();
		reserveRef.current = next;
		onReserve(next);
	};

	// Explicit expand (bar click): the smooth scroll to the bottom takes hundreds of ms
	const expandIntentRef = useRef(false);
	const intentTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const suppressFoldDuringReveal = () => {
		expandIntentRef.current = true;
		clearTimeout(intentTimerRef.current);
		intentTimerRef.current = setTimeout(() => {
			expandIntentRef.current = false;
		}, 2000);
		return Promise.resolve(scrollToBottom()).finally(() => {
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = false;
		});
	};
	const expandAndReveal = () => {
		setRevealed(true); // the teach-check invitation was accepted (W5)
		setExpanded(true);
		void suppressFoldDuringReveal();
	};
	const expandAndRevealRef = useRef(expandAndReveal);
	expandAndRevealRef.current = expandAndReveal;
	// ENTER OPENS THE WAITING CHECK: while a question waits with the dock CLOSED — behind its reveal invitation or collapsed by scroll
	useEffect(() => {
		if (!pending || expanded) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.altKey) return;
			if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
			const t = e.target as HTMLElement | null;
			if (
				t &&
				((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") ||
				t.tagName === "TEXTAREA" ||
				t.isContentEditable ||
				t.closest("button"))
			)
				return;
			e.preventDefault();
			void finishDictation().then(() => {
				expandAndRevealRef.current();
			});
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [pending, expanded]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			if (!pendingRef.current) return;
			// Resize mute: a geometry change re-clamps scrollTop and the browser emits the clamp as a scroll event
			if (Date.now() - geometryAtRef.current < 400) return;
			// Growth mute: the transcript growing under a live turn is not the learner leaving.
			if (Date.now() - growthAtRef.current < 400) return;
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expandedRef.current) {
				// INTENT-GATED FOLD: distance alone folded on stick-to-bottom's catch-up transients
				if (d > COLLAPSE_DIST && !expandIntentRef.current && !atBottomRef.current) setExpanded(false);
			} else if (d < EXPAND_DIST) {
				// Teach checks stay collapsed until the learner opens them (W5): the at-bottom auto-expand would pop the form over the teaching.
				if (requiresRevealRef.current && !revealedRef.current) return;
				setExpanded(true);
				void scrollToBottom();
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [scrollRef, scrollToBottom]);

	// The settled block height (gradient excluded), offered to the spacer.
	const measureBlock = () => {
		const b = blockRef.current;
		if (b) offer(b.getBoundingClientRect().height);
	};

	const mode = pending
		? `question:${pending.toolCallId}`
		: practice
			? `practice:${practice.toolCallId}`
			: "chat";
	// The opening variant of a session appears instantly — the fade/rise is reserved for mid-session transitions.
	const initialModeRef = useRef(mode);

	// Height morph: animate the shell from its previous height to its new one whenever the variant (chat ↔ question ↔ collapsed bar) changes.
	const shellRef = useRef<HTMLDivElement>(null);
	// The fold's CONTENT fade: the shell height morphs, but the bar↔form content used to hard-swap.
	const contentRef = useRef<HTMLDivElement>(null);
	const prevExpandedForFadeRef = useRef(expanded);
	useIsoLayoutEffect(() => {
		if (prevExpandedForFadeRef.current === expanded) return;
		prevExpandedForFadeRef.current = expanded;
		contentRef.current?.animate(
			[{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
			{ duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
	}, [expanded]);
	// The height-morph key (components/dock-state-key.ts): the expanded term (the fold) belongs to EVERY docked variant — question AND practice.
	const stateKey = dockStateKey(mode, !!pending || !!practice, expanded);
	const prevRef = useRef<{ key: string; height: number } | null>(null);
	useIsoLayoutEffect(() => {
		const el = shellRef.current;
		if (!el) return;
		const p = prevRef.current;
		if (p && p.key === stateKey) {
			// Same variant: keep the settled height fresh, but never measure while a morph is in flight
			if (el.getAnimations().length === 0) {
				const h = el.getBoundingClientRect().height;
				p.height = h;
				measureBlock(); // typing growth → the spacer grows with the box
			}
			return;
		}
		el.getAnimations().forEach((a) => a.cancel()); // flush to natural height before measuring
		const h = el.getBoundingClientRect().height;
		// Variant change → re-reserve.
		measureBlock();
		if (p && Math.abs(p.height - h) > 1) {
			el.animate([{ height: `${p.height}px` }, { height: `${h}px` }], {
				duration: 120,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
			});
		}
		prevRef.current = { key: stateKey, height: h };
	});

	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ right: sbInset }}>
			<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
			<div ref={blockRef} className="relative bg-background pb-5" style={{ "--dock-max-h": dockMaxH ? `${dockMaxH}px` : undefined } as React.CSSProperties}>
				<div className={DOCK}>
					{setupCta}
					{/* The queued-steer indicator: quiet one-liners above the shell - right-aligned to where its corner rounding starts, truncated, no background… */}
					<QueuedSteersBody steers={queuedSteers} />
					{/* The reading-thinking field: mounted while a teach-phase check waits — the same cue that collapses it. */}
					{pending && requiresReveal && (
						<ReadingThinkingField
							value={readingThinking}
							onChange={onReadingThinking}
							onEscape={dictationCancel}
							onOpen={
								!expanded
									? () => {
											void finishDictation().then(() => {
												expandAndRevealRef.current();
											});
										}
									: undefined
							}
							claim={revealPending}
						/>
					)}
					<div ref={shellRef} className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
						<div
						ref={contentRef}
						key={mode}
						className={mode === initialModeRef.current ? undefined : "dock-variant"}
					>
							{pending ? (
								<QuestionDock
									toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={expanded}
									reveal={revealPending}
									phase={phase}
									onExpand={expandAndReveal}
									onSubmit={onSubmitAnswer}
									initialDraft={initialQuestionDraft}
									onSaveDraft={onSaveQuestionDraft}
									onEscape={dictationCancel}
									dictationClaim={!revealPending}
									compactionRunning={compactionRunning}
								/>
							) : practice ? (
								<PracticeDock
									problemCallId={practice.toolCallId}
									input={practice.input as { statement: string }}
									expanded={expanded}
									onExpand={() => {
										setExpanded(true);
										void suppressFoldDuringReveal();
									}}
									onSubmit={onSubmitThinking}
									onEscape={dictationCancel}
									compactionRunning={compactionRunning}
								/>
							) : (
								composer
							)}
						</div>
					</div>
					{/* The stats row: beneath the composer/question shell, not flush to the screen bottom — static height… */}
					<StatsBar
						turns={turns}
						contextTokens={contextTokens}
						pricing={pricing}
						dictationSlot={dictationSlot}
						chatId={chatId}
					/>
					{/* The scroll-down disc: anchored to the BLOCK's top edge — above the composer shell AND the stats row, in the gradient's transparent band… */}
					<ConversationScrollButton className="pointer-events-auto bottom-full mb-2" />
				</div>
				{/* The plan marginalia: the bare diagram in the band's right flank — boundaless, meet-fitted, part of the lesson's page rather than a floating widget. */}
				{pending && plan && (
					<Hint label="Open the full plan" side="bottom">
<button
						type="button"
						data-testid="plan-marginalia"
						onClick={onOpenPlan}
						style={{ left: `calc(50% + ${DOCK_W / 2 + MARGIN_GAP}px)` }}
						className={`absolute bottom-5 right-4 top-0 cursor-pointer transition-[filter,opacity] duration-300 ease-out ${
							expanded && flankW >= MARGIN_MIN_W
								? "pointer-events-auto opacity-100 blur-0"
								: "pointer-events-none opacity-0 blur-md"
						}`}
					>
						{plan}
					</button>
</Hint>
				)}
			</div>
		</div>
	);
}
