"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon, DumbbellIcon } from "lucide-react";
import { GraphView } from "@/components/graph-view";
import { MinimalHome } from "@/components/minimal-home";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import type { TurnUsage } from "@/src/core";

/** Home — the knowledge graph is the main view, full-bleed edge to edge: the canvas owns the whole column */
export function Home({
	initialConfigured,
	rendering = true,
}: {
	initialConfigured: boolean;
	/** GRAPH RENDERING off: the home's main view is the chains view, not the canvas. */
	rendering?: boolean;
}) {
	const router = useRouter();
	const [topic, setTopic] = useState("");
	/* The topic MIRROR: a dictation flush lands via setState, invisible to a closure that waited through `await finish()`. */
	const topicRef = useRef("");
	// Voice dictation: finals append at the end of the topic draft; the strip lives in the stats bar's middle slot.
	const dictation = useDictation({
		// Ref-first: the join reads the mirror so the send resuming after `await finish()` sees the dictated tail.
		append: (t) => {
			const v = joinDictation(topicRef.current, t);
			topicRef.current = v;
			setTopic(v);
		},
	});
	const [busy, setBusy] = useState(false);
	/* Run end focuses the topic input: the hands are on the keyboard from the stop. */
	const topicInputRef = useRef<HTMLTextAreaElement>(null);
	// Tab navigates INTO the topic composer: the only text field on this surface — and home's composer is its OWN textarea
	const cycleTopicField = useCallback(
		(): readonly HTMLElement[] => (topicInputRef.current ? [topicInputRef.current] : []),
		[],
	);
	useFieldCycle(cycleTopicField);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			topicInputRef.current?.focus();
		}
	}, [dictation.active]);

	/* PRACTICE MODE: the graph composer's teach | practice switch */
	const [mode, setMode] = useState<"teach" | "practice">("teach");
	const [practiceProps, setPracticeProps] = useState<{ id: string; name: string; statement: string }[]>([]);
	const [chainSelectOpen, setChainSelectOpen] = useState(false);
	// The chain table is CONTROLLED off this id set (the lifted pick).
	const pickedIds = useMemo(() => new Set(practiceProps.map((p) => p.id)), [practiceProps]);

	/* FINISH DICTATION FIRST: Enter may arrive while a run is live with the topic still deferred in the run's buffer — stop the run */
	const start = () => {
		if (!dictation.active) {
			void begin();
			return;
		}
		void dictation.finish().then(() => begin());
	};
	const begin = async () => {
		const t = topicRef.current.trim();
		if (!t || busy) return;
		setBusy(true);
		try {
			// The map context: picks in EITHER mode ride the CREATION as graphContext
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: t,
					...(mode === "practice" ? { kind: "practice" } : {}),
					...(practiceProps.length > 0 ? { graphContext: { propositions: practiceProps } } : {}),
				}),
			});
			const { id } = (await res.json()) as { id: string };
			// No settings PUT on create: the SERVER stamps the newborn from the strong slot — the same default this surface's model control edits.
			router.push(`/chat/${id}?prompt=${encodeURIComponent(t)}`);
		} catch {
			setBusy(false);
		}
	};

	return (
		<div className="relative h-dvh">
			{/* Window-drag strip: a dedicated mask element, deliberately FIRST in the DOM. */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />

			{/* The main view — full-bleed: no padding on any side; it runs from the sidebar to the right edge and from the bottom to the top, under everything else. */}
			<main className="absolute inset-0">
				{rendering ? (
					<GraphView
						chainSelectOpen={chainSelectOpen}
						practiceSelection={pickedIds}
						onPracticeSelectionChange={setPracticeProps}
						onChainSelectClose={() => setChainSelectOpen(false)}
					/>
				) : (
					<MinimalHome
						chainSelectOpen={chainSelectOpen}
						practiceSelection={pickedIds}
						onPracticeSelectionChange={setPracticeProps}
						onChainSelectClose={() => setChainSelectOpen(false)}
					/>
				)}
			</main>

			{/* Header floats over the graph — pointer-events-none except the toggle, so the canvas stays draggable/hoverable around it. */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>

			{/* New session — same floating blob as the chat composer, docked OVER the graph (no gradient: the graph runs clean under it to the bottom edge). */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 pb-5">
				<div className="pointer-events-auto mx-auto w-full max-w-[46rem] px-4">
					{/* The pick bar: the chain table's selection is PERSISTENT — picked propositions show here as a count + Clear in EITHER mode (it survives mode switches… */}
					<ComposerActions
						picker={(practiceProps.length > 0 || mode === "practice") && (
							<NodePickerControl
								count={practiceProps.length}
								onOpen={() => setChainSelectOpen(true)}
								onClear={() => setPracticeProps([])}
							/>
						)}
					/>
					<form
						className="flex items-end gap-1.5 rounded-2xl border bg-card p-1.5 shadow-lg"
					onSubmit={(e) => {
						e.preventDefault();
						void start();
					}}
				>
					<textarea
						ref={topicInputRef}
						value={topic}
						onChange={(e) => {
							topicRef.current = e.target.value;
							setTopic(e.target.value);
						}}
						onKeyDown={(e) => {
							// Esc ends dictation (the dictate decisions: click-again or Esc) — stopPropagation claims it so the window chain doesn't also abort a turn.
							if (e.key === "Escape" && dictation.active) {
								e.preventDefault();
								e.stopPropagation();
								dictation.cancel();
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void start();
							}
						}}
						placeholder={mode === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
						autoFocus
						rows={1}
						className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
					/>
					{/* No tooltip on the start square — the ↵ glyph is the affordance. */}
					<button
						type="submit"
						aria-label="Start session"
						disabled={(!topic.trim() && !dictation.active) || busy}
						className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40"
					>
						<CornerDownLeftIcon className="size-5" />
					</button>
					</form>
					{/* Same as the chat view's under-composer stats bar — no session yet, so the LEFT side renders nothing while the RIGHT keeps the strong-slot control. */}
					<StatsBar
						dictationSlot={<DictationBar dictation={dictation} />}
						turns={[] as TurnUsage[]}
						leadingSlot={
							<div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="home-mode-switch">
								{(["teach", "practice"] as const).map((m) => (
									<button
										key={m}
										type="button"
										data-testid={`home-mode-${m}`}
										onClick={() => setMode(m)}
										className={
											"flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors " +
											(mode === m
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:text-foreground")
										}
									>
										{m === "practice" ? <DumbbellIcon aria-hidden="true" className="size-3" /> : null}
										{m === "teach" ? "Teach" : "Practice"}
									</button>
								))}
							</div>
						}
					/>
				</div>
			</div>

		</div>
	);
}
