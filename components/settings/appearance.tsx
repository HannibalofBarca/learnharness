"use client";
/** THE APPEARANCE APPLICATION: the settings record's appearance section actually DOES something */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FACTORY_SETTINGS, type AppearanceSettings } from "@/src/core";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** One channel clamped on the dark curve: additive offsets matching today's hand-picked palette (#141414 → card #1c1c1c (+8) → accent #2a2a2a (+22) → */
function raise(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.min(255, c + add).toString(16).padStart(2, "0")).join("")}`;
}

/** The derived palette a chosen background implies (dark curve): background itself, the raised surfaces (card/popover/secondary/muted, +8) */
function derivedPalette(background: string): Record<string, string> {
	const card = raise(background, 8);
	const accent = raise(background, 22);
	const border = raise(background, 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
function appearanceVars(a: ReturnType<typeof resolveAppearance>): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.background !== null) Object.assign(vars, derivedPalette(a.background));
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable: prose, inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font to the prose family
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set — these get removeProperty so the factory stylesheet value returns. */
function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	const appliedRef = useRef<string>("");

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolveAppearance(delta)), [delta]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job: a later write that OMITS a var (empty field = factory
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// One fetch per app load: the record (sanitized server-side) carries the delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance slice is unknown-shaped here
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const value = useMemo(
		() => ({ appearance: resolveAppearance(delta), onAppearanceChange }),
		[delta, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}