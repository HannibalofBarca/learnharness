"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Composer } from "@/components/composer";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import type { GraphSnapshot } from "@/src/core";

/** The draft's pick set: the SAME shape the home pick bar lifts — resolved nodes as the learner SAW them at pick time. */
type DraftPick = { id: string; name: string; statement: string };

/** The sessionless draft view at /chat/new: "+ New session" opens THIS, never a created record */

const DOCK = "mx-auto w-full max-w-[46rem] px-4";

/** The draft's whole behavior as one pure seam: create the session (title = the first message), persist the lifted pre-chat settings */
async function startDraftSession(
	text: string,
	fetchLike: typeof fetch,
	mode?: "practice",
	picks?: readonly DraftPick[],
): Promise<string | null> {
	const t = text.trim();
	if (!t) return null;
	// THE PICKS RIDE THE CREATE: a practice draft seeded from the pick bar creates its session WITH the graph context
	const res = await fetchLike("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			mode === "practice"
				? { title: t, kind: "practice", ...(picks && picks.length > 0 ? { graphContext: { propositions: picks } } : {}) }
				: { title: t },
		),
	});
	const { id } = (await res.json()) as { id: string };
	// No settings PUT on create: the SERVER stamps the newborn from the strong slot.
	return `/chat/${id}?prompt=${encodeURIComponent(t)}`;
}

/** The pure shell (no router) — the render-test seam: the draft view's visible surface, assembled from the same pieces a fresh chat shows. */
/* FINISH-FIRST SEND + RUN-END FOCUS live in the shell (it owns the dictation instance); the truth of the text stays in the parent */
function DraftShell({
	busy,
	text,
	onChange,
	onSend,
	setupCta,
	mode = "teach",
	picks = [],
	onOpenPicker,
	onClearPicks,
	overlay,
}: {
	busy: boolean;
	text: string;
	onChange: (v: string) => void;
	onSend: () => void;
	/** The practice draft: ?mode=practice — the created session carries kind:"practice" and the copy changes (the practice agent opens; no probing). */
	mode?: "teach" | "practice";
	/** The first-run CTA: the same "Set up your models" affordance home carries, rendered above the draft shell — passed by NewSession */
	setupCta?: ReactNode;
	/** THE PICK BAR: the SAME pill the home screen carries above its composer — dashed "Pick nodes" when empty, count + Clear when picked. */
	picks?: DraftPick[];
	onOpenPicker?: () => void;
	onClearPicks?: () => void;
	/** THE PICKER SLOT: the chain-table overlay hosts INSIDE the content column's relative container */
	overlay?: ReactNode;
}) {
	// Voice dictation: finals append at the end of the draft text (via the parent's onChange — the truth lives there)
	const cycleComposer = useCallback((): readonly HTMLElement[] =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-testid="composer"] textarea')),
		[]);
	useFieldCycle(cycleComposer);
	const dictation = useDictation({
		append: (t) => onChange(joinDictation(text, t)),
	});
	// A LIVE dictation keeps the composer sendable: the spoken text is deferred in the run's buffer — Enter must reach the finish-first send
	const canSend = text.trim().length > 0 || dictation.active;
	/* FINISH DICTATION FIRST: stop the run, let the last finals land through onChange, THEN call the parent's send — which reads its REF mirror */
	const handleSend = () => {
		if (dictation.active) {
			void dictation.finish().then(onSend);
			return;
		}
		onSend();
	};
	/* Run end focuses the composer: the hands are on the keyboard from the stop — falling edge of `active` only. */
	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);
	return (
		/* CHROME-LESS CREATION SURFACE: the drafts join home's register — no TopBar, no title (the serif title always names a session; a draft has none). */
		<div className="relative flex h-dvh">
			{/* Window-drag strip — deliberately FIRST in the DOM (the mask law: no-drag subtraction resolves by DOM order… */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1">
					{/* The pointer-events pattern (953b22b): the sticky wrapper is pointer-events-none so nothing here blocks the empty-state area… */}
					<div className="pointer-events-none sticky bottom-0 mt-auto w-full">
						<Conversation className="h-full min-w-0 flex-1" initial="instant">
							<ConversationContent className="min-h-full gap-0 p-0">
								<ConversationEmptyState
									title={mode === "practice" ? "New practice session" : "New session"}
									description={
										mode === "practice"
											? "Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."
											: "The teacher will open by probing what you already know."
									}
								/>
							</ConversationContent>
						</Conversation>
						<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
						<div className="bg-background pb-4">
							<div className={DOCK}>
								<ComposerActions
									picker={(picks.length > 0 || mode === "practice") && (
										<NodePickerControl count={picks.length} onOpen={onOpenPicker} onClear={onClearPicks} />
									)}
									setup={setupCta}
								/>
								<div className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
									<Composer
										busy={busy}
										value={text}
										onChange={onChange}
										onSend={handleSend}
										onStop={() => {}}
										canSend={canSend}
										inputRef={composerInputRef}
										autoFocus
										onEscape={dictation.active ? dictation.cancel : undefined}
										// The opening question, same as the graph view's new-session input — no lesson has started yet, so the composer must not read like one is in flight.
										placeholder={mode === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
									/>
								</div>
								<StatsBar
									dictationSlot={<DictationBar dictation={dictation} />}
									turns={[]}
								/>
							</div>
						</div>
					</div>
					{overlay}
				</div>
			</div>
			{/* The floating reopen toggle — pointer-events-none except the toggle itself (home's pattern)… */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>
		</div>
	);
}

export function NewSession({ initialConfigured, mode = "teach" }: { initialConfigured: boolean; mode?: "teach" | "practice" }) {
	const router = useRouter();
	const [text, setText] = useState("");
	/* The draft MIRROR: the shell's finish-first send calls THIS send after the dictation flush */
	const textRef = useRef("");
	const applyText = (v: string) => {
		textRef.current = v;
		setText(v);
	};
	const [busy, setBusy] = useState(false);
	// THE PICK BAR: the draft's lifted pick set + the snapshot the standalone chain-table picker reads.
	const [picks, setPicks] = useState<DraftPick[]>([]);
	const picksRef = useRef<DraftPick[]>([]);
	const applyPicks = (next: DraftPick[]) => {
		picksRef.current = next;
		setPicks(next);
	};
	const [pickerOpen, setPickerOpen] = useState(false);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const openPicker = () => {
		if (snapshot) {
			setPickerOpen(true);
			return;
		}
		void fetch("/api/graph")
			.then((r) => r.json() as Promise<GraphSnapshot>)
			.then((snap) => {
				setSnapshot(snap);
				setPickerOpen(true);
			})
			.catch(() => {
				/* an unreachable graph leaves the draft usable — pickless */
			});
	};

	const send = useCallback(() => {
		const draft = textRef.current.trim();
		if (!draft || busy) return;
		setBusy(true);
		void startDraftSession(draft, fetch, mode === "practice" ? "practice" : undefined, mode === "practice" ? picksRef.current : undefined)
			.then((target) => {
				if (target) router.push(target);
				else setBusy(false);
			})
			.catch(() => setBusy(false));
	}, [busy, router, mode]);

	return (
		<>
			<DraftShell
				busy={busy}
				text={text}
				onChange={applyText}
				onSend={send}
				mode={mode}
				picks={picks}
				onOpenPicker={openPicker}
				onClearPicks={() => applyPicks([])}
				overlay={
					// THE PICKER: hosted INSIDE the content column — absolute inset-0 resolves to the column's relative container
					<ChainTableOverlay
						open={pickerOpen}
						nodes={snapshot?.propositions ?? []}
						chains={snapshot?.chains ?? []}
						sessions={snapshot?.sessions ?? {}}
						fileSources={snapshot?.fileSources ?? {}}
						onClose={() => setPickerOpen(false)}
						selectMode
						controlledSelection={new Set(picks.map((p) => p.id))}
						onSelectionChange={(ids) => {
							const byId = new Map((snapshot?.propositions ?? []).map((n) => [n.id, n]));
							const next: DraftPick[] = [];
							for (const id of ids) {
								const n = byId.get(id);
								if (n) next.push({ id: n.id, name: n.name, statement: n.statement });
							}
							applyPicks(next);
						}}
					/>
				}
			/>
		</>
	);
}