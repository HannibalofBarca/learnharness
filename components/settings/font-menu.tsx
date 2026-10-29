"use client";
/** The reading-font picker: FontMenuList — installed families, the always-offerable DEFAULT row and a custom-family escape input, over a fuzzy search. */

import { useEffect, useRef, useState } from "react";
import { fuzzyScore } from "@/src/core";

/** The reading-font dropdown's row set — the SAME fuzzy + arrow-walk +
 *  Enter machine over font families (appearance wave, 2026-09-26). The
 *  DEFAULT row (null) is a candidate like any family: it matches empty
 *  and "source"/"sans"/"default" queries, so an unfiltered list opens
 *  with the default first and a searched list drops it honestly — Enter
 *  can never pick a row that isn't on screen. Pure — exported for
 *  tests. */
function fontMenuResults(query: string, families: string[]): Array<string | null> {
	const scored = families
		.map((f) => ({ f, s: fuzzyScore(query, f) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => b.s! - a.s! || a.f.localeCompare(b.f))
		.map((r) => r.f);
	// The default row's searchable identity: the factory family + the word "default" (the suffix it renders with).
	const defaultScore = fuzzyScore(query, "Source Sans 3", "default");
	if (query.trim() === "" || defaultScore !== null) return [null, ...scored];
	return scored;
}

/** The custom-family action row's decision: a typed query that matches NO family becomes the "Use '<query>'" custom pick */
function customFamilyFor(query: string, families: string[]): string | null {
	const trimmed = query.trim();
	if (trimmed === "") return null;
	return fontMenuResults(query, families).length === 0 ? trimmed : null;
}

/** The reading-font dropdown body — ONE search field: the fuzzy machine filters the families, and when nothing matches */
export function FontMenuList({
	families,
	effectiveFamily,
	onPick,
	footer,
}: {
	/** Enumerated font families (already deduped/sorted by the caller); undefined while the enumeration runs. */
	families: string[] | undefined;
	/** The stored override (null = the factory Source Sans 3). */
	effectiveFamily: string | null;
	/** Receives the pick: a family string, or null for the default. */
	onPick: (family: string | null) => void;
	/** Quiet footer note under the list. */
	footer?: string;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = fontMenuResults(query, families ?? []);
	// The custom-family action row: only when a typed query matches nothing (a matching family is the better pick).
	const customFamily = customFamilyFor(query, families ?? []);
	const walkable: Array<string | null> = customFamily !== null ? ["__custom__"] : results;

	return (
		<>
			<input
				ref={searchRef}
				data-testid="font-search"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setMenuIdx(null); // new query → the walk restarts on Enter/↓
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						e.stopPropagation();
						if (walkable.length === 0) return;
						setMenuIdx((i) =>
							e.key === "ArrowDown"
								? Math.min((i ?? -1) + 1, walkable.length - 1)
								: Math.max((i ?? walkable.length) - 1, 0),
						);
					} else if (e.key === "Enter") {
						const chosen = walkable[menuIdx ?? 0];
						if (chosen !== undefined) {
							e.preventDefault();
							e.stopPropagation();
							onPick(chosen === "__custom__" ? customFamily : chosen);
						}
					}
				}}
				placeholder="Search fonts…"
				className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
			/>
			{!families && <div className="px-2 py-3 text-center text-muted-foreground">Loading fonts…</div>}
			<ul ref={listRef} data-testid="font-list" className="flex max-h-72 flex-col overflow-y-auto px-1">
				{families &&
					results.map((family, i) => {
						const isDefault = family === null;
						const effective = isDefault ? effectiveFamily === null : family === effectiveFamily;
						return (
							<li key={family ?? "__default"}>
								<button
									type="button"
									data-testid={isDefault ? "font-option-default" : `font-option-${family.replace(/[^a-z0-9-]/gi, "_")}`}
									data-idx={i}
									onClick={() => onPick(family)}
									className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
										i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
									}${effective && i !== menuIdx ? " bg-muted/60" : ""}`}
								>
									<span className="truncate text-card-foreground">{family ?? "Source Sans 3"}</span>
									<span className="shrink-0 text-muted-foreground">{isDefault ? "default" : effective && <span aria-hidden>✓</span>}</span>
								</button>
							</li>
						);
					})}
				{families && customFamily !== null && (
					<li>
						<button
							type="button"
							data-testid="font-option-custom"
							data-idx={0}
							onClick={() => onPick(customFamily)}
							className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
								menuIdx === 0 ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
							}`}
						>
							<span className="truncate text-card-foreground">Use “{customFamily}”</span>
							<span className="shrink-0 text-muted-foreground">custom</span>
						</button>
					</li>
				)}
			</ul>
			{footer && <div className="px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>}
		</>
	);
}
