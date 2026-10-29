"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";

/** Voice dictation — the cloud engine. */

/* Deepgram streaming params: nova-3, endpointing=300, no interims. */
const DG_URL =
	"wss://api.deepgram.com/v1/listen" +
	"?model=nova-3" +
	"&encoding=linear16" +
	"&sample_rate=16000" +
	"&channels=1" +
	"&smart_format=true" +
	"&punctuate=true" +
	"&endpointing=300";

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
const METER_CELLS = 48;

/** The Deepgram key's id in the keys store (the env-var name — the Keys section's openRow state and the PUT /api/keys/:id seam). */
const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

/** The client-authored KEYLESS line: the token route's raw 503 message is dev-speak ("add it to auth.json (desktop) or .env.local (dev)") */
const DICTATION_KEYLESS = "Dictation needs a Deepgram key";

/** Mint a fresh short-lived token (the route holds the real key server-side). */
async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

/** Warm-token cache: the click path takes the cached promise instead of a remote mint. */
const WARM_TOKEN_TTL_MS = 3 * 60_000;

type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* Persistent capture graph: one app-lifetime AudioContext + a module-load memo. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/** The primary-input registry: at most ONE non-composer input can claim the dictation target while mounted */
let questionTarget: ((text: string) => void) | null = null;

/* Is a dictation run live on this page? */
let dictationActiveFlag = false;

export function isDictationActive(): boolean {
	return dictationActiveFlag;
}

/* The finisher registry: submit paths FAR from the hook's owner (the pending question's dock) need finish() without a prop bridge. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/** Claim the dictation target while mounted (and `claimed` is true). */
export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

type Dictation = {
	phase: DictationPhase;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE: if a run is live, stop it and resolve only when the run has fully ended */
	finish: () => Promise<void>;
	/** End + DISCARD the transcript: no flush, immediate teardown. */
	cancel: () => void;
	/** Clear the terminal error without starting a run: the keyless click leaves for Settings and the surface must come back clean. */
	clearError: () => void;
};

/** One dictation instance per composer-bearing page. */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	/** Latest RMS from the worklet — the meter samples this (dictate pattern). */
	const levelRef = useRef(0);
	/** The page's fallback append — kept fresh per render so a mid-recording retarget (composer↔question) is honored on the very next final. */
	const appendRef = useRef(append);
	appendRef.current = append;

	// Live machinery (non-render values).
	const wsRef = useRef<WebSocket | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	/** Per-run graph nodes — the CONTEXT outlives runs (mitigation C). */
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	/** Frames captured before the socket is OPEN (mitigation A): flushed in order on open; capped at 256 frames (≈32s) with the oldest dropped */
	const pendingRef = useRef<ArrayBuffer[]>([]);
	const genRef = useRef(0); // stale-handler guard (dictate pattern)
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectsRef = useRef(0);
	/** The deferred transcript: finals land here during the run and flush into the primary input once, at teardown. */
	const bufferRef = useRef<string[]>([]);
	/** Resolvers waiting for the run to fully end (finish(), owner 2026-10-01): released by cleanup() — every terminal path runs it. */
	const waitersRef = useRef<Array<() => void>>([]);

	/** Flush the buffered transcript into the primary input — question claim first, composer fallback. */
	const flush = useCallback(() => {
		if (bufferRef.current.length === 0) return;
		const text = bufferRef.current.join(" ");
		bufferRef.current = [];
		(questionTarget ?? appendRef.current)(text);
	}, []);

	/** Full teardown of one run's machinery. Idempotent; generation-guarded by callers. */
	const cleanup = useCallback(() => {
		genRef.current++;
		dictationActiveFlag = false;
		flush(); // the deferred transcript appears when the run ends
		if (safetyRef.current) {
			clearTimeout(safetyRef.current);
			safetyRef.current = null;
		}
		pendingRef.current = [];
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;
		// The AudioContext is app-lifetime (mitigation C) — nodes die, it stays.
		const ws = wsRef.current;
		wsRef.current = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {}
		}
		setPhase("idle");
		// The finish() waiters ride until NOW — post-flush, post-teardown
		for (const w of waitersRef.current.splice(0)) w();
		// Pre-mint for the next run (mitigation D) — best-effort; a keyless page just doesn't warm.
		warmTokens.refresh();
	}, []);

	/** Open the Deepgram socket and wire its messages. `gen` guards staleness. */
	const openSocket = useCallback(
		(gen: number, token: string) => {
			// Minted JWTs authenticate via the "bearer" subprotocol — ["token", jwt] is rejected at the handshake.
			const ws = new WebSocket(DG_URL, ["bearer", token]);
			wsRef.current = ws;

			ws.addEventListener("open", () => {
				if (gen !== genRef.current) return;
				// Mitigation A: everything captured during the handshake (or a reconnect gap) goes out now, in order — Deepgram accepts faster-than-realtime sends.
				for (const frame of pendingRef.current) ws.send(frame);
				pendingRef.current = [];
				setPhase("recording");
			});
			ws.addEventListener("message", (ev) => {
				if (gen !== genRef.current) return;
				let msg: any;
				try {
					msg = JSON.parse(ev.data as string);
				} catch {
					return;
				}
				if (msg.type === "Results") {
					const text: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
					// Only finals stream (interim_results=false).
					if (msg.is_final && text) bufferRef.current.push(text);
				}
			});
			ws.addEventListener("close", (ev) => {
				if (gen !== genRef.current) return;
				if (ev.code === 1000) {
					// Our own CloseStream landing: finalize now — the stop path's safety net stays as the no-close backstop only.
					cleanup();
					return;
				}
				// Abnormal close mid-run: ONE reconnect with a fresh token (the research pass: resume is our job, no SDK to lean on).
				if (reconnectsRef.current < 1) {
					reconnectsRef.current++;
					mintFreshToken() // always FRESH — a stale warm token is the likely culprit
						.then((t) => {
							if (gen === genRef.current) openSocket(gen, t);
						})
						.catch(() => {
							if (gen === genRef.current) {
								setError("Deepgram reconnect failed");
								cleanup();
							}
						});
				} else {
					setError(`Deepgram connection lost (${ev.code})`);
					cleanup();
				}
			});
		},
		[cleanup],
	);

	const start = useCallback(async () => {
		dictationActiveFlag = true;
		setError(null);
		setPhase("connecting");
		reconnectsRef.current = 0;
		bufferRef.current = []; // fresh run, fresh buffer
		pendingRef.current = []; // fresh run, fresh queue (mitigation A)
		const gen = ++genRef.current;

		// Mitigation D: the warm token (pre-minted at mount / after the last run) resolves ~instantly; a cold/keyless mint surfaces below.
		const tokenPromise = warmTokens.mint();
		tokenPromise.catch(() => {}); // surfaced below; no unhandled rejection
		const micPromise = navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		let stream: MediaStream;
		try {
			stream = await micPromise;
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;

			// Mitigation C: app-lifetime context + memoized worklet module — per-run costs (context creation, module fetch) are gone.
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (e) => {
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					levelRef.current = msg.rms ?? 0; // never reset to zero (dictate pattern)
				} else if (msg.type === "audio") {
					const ws = wsRef.current;
					if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer!);
					// Mitigation A: not OPEN yet (handshake or reconnect gap) — queue, capped; the open handler flushes in order.
					else {
						pendingRef.current.push(msg.buffer!);
						if (pendingRef.current.length > 256) pendingRef.current.shift();
					}
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet);
			// Pull the graph with silence out (the worklet writes no output) — an unconnected worklet node is never clocked.
			worklet.connect(ctx.destination);
		} catch (e) {
			if (gen !== genRef.current) return;
			const msg =
				e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
					? "Microphone permission denied"
					: e instanceof Error
						? e.message
						: "mic unavailable";
			setError(msg);
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		let token: string;
		try {
			token = await tokenPromise;
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "token unavailable");
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		// Mitigation B: the handshake fires the moment the graph is live, overlapping any remaining token wait — mic-gated, never before it.
		openSocket(gen, token);
	}, [openSocket, cleanup]);

	const stop = useCallback(() => {
		const gen = genRef.current;
		if (phase !== "recording" && phase !== "connecting") return;
		setPhase("stopping");

		// Mic dies FIRST — no more audio enqueues (dictate pattern).
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;

		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "CloseStream" }));
			} catch {
				cleanup();
				return;
			}
			// Deepgram flushes remaining finals then closes; if it never does, the safety net ends the run anyway (dictate pattern).
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) cleanup();
			}, 3000);
		} else {
			cleanup();
		}
	}, [phase, cleanup]);

	const cancel = useCallback(() => {
		if (phase === "idle") return;
		// Discard first, teardown second — cleanup() flushes, and the now-empty buffer makes that flush a no-op.
		bufferRef.current = [];
		cleanup();
	}, [phase, cleanup]);

	const finish = useCallback((): Promise<void> => {
		return new Promise((resolve) => {
			if (phase === "idle") {
				resolve();
				return;
			}
			waitersRef.current.push(resolve);
			// "stopping" is already ending — the waiter just rides to cleanup.
			if (phase === "recording" || phase === "connecting") stop();
		});
	}, [phase, stop]);

	// Publish finish() for the sibling subtrees (the pending question's dock) — registered for as long as this page owns the hook.
	useEffect(() => {
		dictationFinisher = finish;
		return () => {
			if (dictationFinisher === finish) dictationFinisher = null;
		};
	}, [finish]);

	const toggle = useCallback(() => {
		if (phase === "idle") void start();
		else if (phase === "recording" || phase === "connecting") stop();
		// "stopping" presses are ignored — the flush is in flight.
	}, [phase, start, stop]);

	// Shortcut seams: ⌘D toggles from anywhere on the page; the Esc chain lands here as a CANCEL.
	useEffect(() => {
		warmTokens.refresh(); // pre-mint at mount (mitigation D) — silent if keyless
	}, []);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-dictation", toggle);
	}, [toggle]);
	useEffect(() => {
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => window.removeEventListener("lh:kbd-cancel-dictation", cancel);
	}, [cancel]);

	return {
		phase,
		error,
		levelRef,
		active: phase !== "idle",
		toggle,
		stop,
		finish,
		cancel,
		clearError: () => setError(null),
	};
}

/** The stats-bar dictation slot: the row's middle is one strip that is always the full free width — idle a wide, quiet "Dictate" button. */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, levelRef, toggle, active, clearError } = dictation;
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click: the errored idle button deep-links Settings → Keys → the Deepgram row and clears the error */
	const keyless = error === DICTATION_KEYLESS;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	/** Adaptive cell count: derived from the meter's measured width — narrow rows show fewer bars instead of overflowing under neighbors. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The meter's own heartbeat — 60ms samples of the level ref into a rolling ring.
	useEffect(() => {
		if (!active) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef]);

	// Fit the cell count to the available width (4px pitch per cell: 2px bar + 2px gap, clamped 8..48).
	useEffect(() => {
		if (!active) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	if (!active) {
		return (
			<Hint
				// Errored: the button span truncates the line — the tooltip is its full reveal.
				label={error ?? "Dictate"}
				action={error ? undefined : "toggle-dictation"}
				side="top"
			>
				<button
					type="button"
					onClick={() => {
						if (keyless) {
							clearError();
							openSettings("keys", DEEPGRAM_KEY_ID);
						} else {
							toggle();
						}
					}}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
				// Same blurring as the floating chrome, but lower opacity — the mic stays quieter than the model pills.
			className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
			>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? "Dictate"}</span>
				</button>
			</Hint>
		);
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint
				// The owner flagged this copy good ("Stop dictation (Esc)") — kept verbatim; only the machinery moved to the styled tooltip.
				label="Stop dictation (Esc)"
				side="top"
			>
				<button
					type="button"
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
				data-testid="dictation-toggle"
				className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
			>
				{phase === "stopping" ? (
					<Loader2Icon className="size-3.5 animate-spin" />
				) : (
					<MicIcon className="size-3.5" />
				)}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			{/* Fixed width while recording — nothing ever appends text beside it. */}
			<div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>
		</div>
	);
}
