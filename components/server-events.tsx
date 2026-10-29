"use client";

/** THE NOTIFICATION CHANNEL'S CLIENT HALF: ONE EventSource("/api/events") per open window, held for the window's lifetime */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { SERVER_EVENT_TYPES, type ServerEventType, type ServerEvents } from "@/src/core";

/** The minimal source surface the provider consumes — EventSource behind this in production, fakes in tests. */
interface NotifySource {
	close(): void;
	onOpen(cb: () => void): void;
	onEvent(name: string, cb: (data: string) => void): void;
}

function openEventsChannel(): NotifySource {
	const es = new EventSource("/api/events");
	return {
		close: () => es.close(),
		onOpen: (cb) => {
			es.onopen = () => cb();
		},
		onEvent: (name, cb) => {
			es.addEventListener(name, (ev) => cb((ev as MessageEvent).data));
		},
	};
}

/** The per-window fan-out: typed subscriptions over one source. */
function createNotifyHub() {
	const byType = new Map<string, Set<(data: never) => void>>();
	const resyncs = new Set<() => void>();
	return {
		subscribe<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void) {
			const set = byType.get(type) ?? new Set<(data: never) => void>();
			byType.set(type, set);
			const slot = cb as unknown as (data: never) => void;
			set.add(slot);
			return () => set.delete(slot);
		},
		/** Resync callbacks: fired on the source's every (re)open — "you may have missed events while disconnected; refetch". */
		onResync(cb: () => void) {
			resyncs.add(cb);
			return () => resyncs.delete(cb);
		},
		/** One named frame arrived: parse, fan out. */
		dispatch(name: string, raw: string) {
			const set = byType.get(name);
			if (!set) return;
			let payload: unknown;
			try {
				payload = JSON.parse(raw);
			} catch (err) {
				console.error(`[events] unparseable frame for ${name}:`, err);
				return;
			}
			for (const cb of [...set]) {
				try {
					(cb as unknown as (data: unknown) => void)(payload);
				} catch (err) {
					console.error(`[events] ${name} handler failed:`, err);
				}
			}
		},
		fireOpen() {
			for (const cb of [...resyncs]) {
				try {
					cb();
				} catch (err) {
					console.error("[events] resync handler failed:", err);
				}
			}
		},
	};
}

/** Wire one source into a hub — the provider's ENTIRE effect body, factored out so the wiring is testable without React. */
function wireSource(source: NotifySource, hub: ReturnType<typeof createNotifyHub>): () => void {
	for (const name of SERVER_EVENT_TYPES) source.onEvent(name, (raw) => hub.dispatch(name, raw));
	source.onOpen(() => hub.fireOpen());
	return () => source.close();
}

// ── the React glue ──────────────────────────────────────────────────────────

const EventsContext = createContext<ReturnType<typeof createNotifyHub> | null>(null);


export function ServerEventsProvider({ children, connect }: { children: ReactNode; connect?: () => NotifySource }) {
	const hub = useMemo(() => createNotifyHub(), []);
	useEffect(() => wireSource((connect ?? openEventsChannel)(), hub), [hub, connect]);
	return <EventsContext.Provider value={hub}>{children}</EventsContext.Provider>;
}

/** Subscribe to one event type for this component's lifetime. */
export function useServerEvent<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerEvent requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.subscribe(type, (payload) => cbRef.current(payload));
		return () => {
			off();
		};
	}, [hub, type]);
}

/** Refetch truth on every (re)connect of the window's channel — the self-heal seam for EventSource reconnects and dev-server restarts. */
export function useServerResync(cb: () => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerResync requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.onResync(() => cbRef.current());
		return () => {
			off();
		};
	}, [hub]);
}
