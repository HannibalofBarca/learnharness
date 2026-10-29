"use client";
/** The Appearance + Graph sections. */

import { useEffect, useRef, useState } from "react";
import {
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	resolveSettings,
	type AppearanceSettings,
	type GraphSettings,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { useAppearance } from "./appearance.tsx";
import { FontMenuList } from "./font-menu";
import { CommitInput, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

/** The factory reading family — the DEFAULT row's identity (unset = this). */
const DEFAULT_READING_FONT = "Source Sans 3";

/** The dev-browser fallback list (queryLocalFonts is absent there): the app's own knowns plus a handful of ubiquitous macOS families */
const CURATED_FALLBACK_FONTS: readonly string[] = [
	"Arial",
	"CMU Serif",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Helvetica Neue",
	"Menlo",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

/** window.queryLocalFonts' shape as this section consumes it (family is the only field used; the API returns one FontData per FACE — the caller dedupes). */
type LocalFontsApi = () => Promise<Array<{ family: string }>>;

/** The Local Font Access seam — read lazily (SSR has no window, and render-time access would evaluate the API on the server). */
function localFontsApi(): LocalFontsApi | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { queryLocalFonts?: LocalFontsApi }).queryLocalFonts ?? null;
}

/** Compose the reading-font pick: null (or blank) = the factory
 *  Source Sans 3; otherwise the family verbatim (trimmed — the
 *  sanitizer trims again server-side). Pure — exported for tests. */
function composeFontFamily(
	appearance: AppearanceSettings | undefined,
	family: string | null,
): AppearanceSettings {
	const value = family?.trim() ?? "";
	return { ...appearance, fontFamily: value === "" ? null : value };
}

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved } = useAppearance();
	const md = appearance?.mdRendering;

	// The font dropdown's open state + its enumeration cache.
	const [fontMenuOpen, setFontMenuOpen] = useState(false);
	const [localFonts, setLocalFonts] = useState<string[] | null | undefined>(undefined);
	const [enumEmpty, setEnumEmpty] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	// The enumeration runs INSIDE the trigger click — queryLocalFonts requires user activation, so it cannot be a mount effect.
	const openFontMenu = () => {
		setFontMenuOpen((open) => {
			if (!open && localFonts === undefined) {
				const api = localFontsApi();
				if (api === null) {
					setLocalFonts(null);
					setEnumEmpty(false);
				} else {
					void api()
						.then((fonts) => {
							const families = [...new Set(fonts.map((f) => f.family))]
								.filter((f) => f !== DEFAULT_READING_FONT)
								.sort((a, b) => a.localeCompare(b));
							if (families.length === 0) {
								// Resolved-but-empty: not a failure the catch sees — an honest unavailable (this Electron 44 build enumerates nothing even granted).
								setLocalFonts(null);
								setEnumEmpty(true);
							} else {
								setLocalFonts(families);
							}
						})
						.catch(() => {
							setLocalFonts(null);
							setEnumEmpty(false);
						});
				}
			}
			return !open;
		});
	};

	const pickFont = (family: string | null) => {
		setFontMenuOpen(false);
		onSectionChange(composeFontFamily(appearance, family));
	};

	// The dropdown contract (agent-section's, mirrored): any click outside the open menu — or an Esc — closes it.
	useEffect(() => {
		if (!fontMenuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setFontMenuOpen(false);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setFontMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [fontMenuOpen]);

	return (
		<>
			<SettingsRow label="Mode" hint="Coming soon" testid="row-mode" dimmed>
				<ThinSelect value="dark" ariaLabel="mode" onChange={() => {}} testid="select-mode" disabled>
					<option value="dark">Dark</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Background"
				hint={`Empty = ${resolved.background ?? "#141414"}`}
				testid="row-background"
			>
				<CommitInput
					value={appearance?.background ?? ""}
					placeholder="#141414"
					ariaLabel="background hex"
					testid="input-background"
					onCommit={(v) => onSectionChange({ ...appearance, background: v === "" ? null : v })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Reading font"
				hint={`Empty = ${DEFAULT_READING_FONT}`}
				testid="row-font"
			>
				<span ref={fontMenuOpen ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
					{/* The MenuTrigger look (agent-section's collapsed
					    select — it lives unexported there, so the
					    classes ride inline; the searchable machine is
					    the shared part). The tooltip rides the CLOSED
					    button ONLY (owner ruling 2026-09-26: never while
					    the dropdown is out — it popped over the open
					    menu when the wrap covered the whole anchor
					    span). */}
					{(() => {
						const triggerButton = (
							<button
								type="button"
								aria-label="Reading font"
								aria-expanded={fontMenuOpen}
								data-testid="font-trigger"
								onClick={openFontMenu}
								className="flex h-7 min-w-20 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
							>
								<span className="min-w-0 flex-1 truncate">{appearance?.fontFamily || DEFAULT_READING_FONT}</span>
								<span aria-hidden className="text-muted-foreground">
									▾
								</span>
							</button>
						);
						return fontMenuOpen ? (
							triggerButton
						) : (
							<Hint label="Choose from your installed fonts" side="left">
								{triggerButton}
							</Hint>
						);
					})()}
					{fontMenuOpen && (
						<MenuShell
							preferredSide="down"
							anchorTestid="font-trigger"
							testid="font-menu"
							menuClass="flex w-[18rem] flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
						>
							<FontMenuList
								families={localFonts === undefined ? undefined : (localFonts ?? [...CURATED_FALLBACK_FONTS])}
								effectiveFamily={appearance?.fontFamily ?? null}
								onPick={pickFont}
								footer={
									localFonts === undefined
										? undefined
										: localFonts === null
											? enumEmpty
												? "Common families — installed fonts could not be read"
												: "Common families — your installed list needs the desktop app"
											: "Your installed fonts"
								}
							/>
						</MenuShell>
					)}
				</span>
			</SettingsRow>
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="16"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						// Empty = factory default: omit the key so the record UNSETS and the field stays empty (absence, not null, is the unset for numbers).
						if (v === "") {
							onSectionChange({ ...appearance, proseFontSize: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Session names in serif" testid="row-session-serif">
				<Toggle
					checked={appearance?.sessionNameSerif ?? true}
					label="session names serif"
					onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="900"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						// Empty = factory default: Number("") is 0, so Absence is the unset representation — the old clamp wrote 100.
						if (v === "") {
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
			{/* The emphasis inks default to the REGULAR TEXT COLOR now — the empty-state labels say so; explicit hex overrides ride unchanged. */}
			<SettingsRow label="Bold color" hint="Empty = same as text" testid="row-bold-color">
				<CommitInput
					value={md?.boldColor ?? ""}
					placeholder="same as text"
					ariaLabel="bold color"
					testid="input-bold-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, boldColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
			<SettingsRow label="Italic color" hint="Empty = same as text" testid="row-italic-color">
				<CommitInput
					value={md?.italicColor ?? ""}
					placeholder="same as text"
					ariaLabel="italic color"
					testid="input-italic-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, italicColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	// Wave 7 collapse: the section is the MASTER SWITCH — the embedding/clustering/labeling rungs are gone
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			{/* EXTRACTION: this switch is the DATA channel — the pipeline, the auditor, the prober's graph tools. */}
			<SettingsRow label="Extraction" hint="Off = the graph stops growing" testid="graph-row-enabled">
				<Toggle
					checked={graph?.enabled ?? true}
					label="extraction enabled"
					onChange={(on) =>
						// Compose, never replace-whole (the section PUT is, but the row must not drop its sibling field — fixed with the budget row's arrival
						onSectionChange({ ...graph, enabled: on })
					}
				/>
			</SettingsRow>
			{/* GRAPH RENDERING: display-only. */}
			<SettingsRow label="Graph rendering" hint="Off = home shows the chains view" testid="graph-row-rendering">
				<Toggle
					checked={graph?.rendering ?? true}
					label="graph rendering enabled"
					onChange={(on) => onSectionChange({ ...graph, rendering: on })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Extraction chunk budget"
				hint={`${resolved.extractionChunkTokens} tok`}
				testid="graph-row-chunk-tokens"
			>
				<CommitInput
					type="number"
					value={String(graph?.extractionChunkTokens ?? "")}
					placeholder={String(resolved.extractionChunkTokens)}
					ariaLabel="extraction chunk budget"
					testid="input-chunk-tokens"
					onCommit={(v) => {
						// Empty = factory default: absence is the unset for numbers — Number("") is 0, so clamping would write the floor instead of unsetting.
						if (v === "") {
							onSectionChange({ ...graph, extractionChunkTokens: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
						// Mirror the server sanitize exactly: floor only (cost protection), no ceiling — a big budget is the user's call.
						onSectionChange({
							...graph,
							extractionChunkTokens: Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n)),
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}