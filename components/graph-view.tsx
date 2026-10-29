"use client";

/** The home knowledge-graph view (W4; vision §1 "Rendering"). */

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import.tsx";
import Link from "next/link";
import { FileTextIcon, ListTreeIcon, Loader2Icon, SearchIcon, SettingsIcon, UploadIcon, WaypointsIcon } from "lucide-react";
import { incrementalLayout, propositionSessionHref, type GraphNode, type GraphSnapshot } from "@/src/core";
import { GraphCanvasRenderer, type GraphRenderSettings } from "./graph-canvas.ts";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useActivity } from "@/components/activity-dock";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { MenuShell } from "@/components/menu-shell.tsx";
import { DeleteNodeDialog } from "@/components/delete-node-dialog.tsx";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { Hint } from "@/components/ui/hint";
import {
	ARROW_LENGTH_LADDER,
	CHARGE_RANGE,
	CLUSTER_LABEL_SIZE_LADDER,
	CLUSTER_PULL_RANGE,
	DEPTH_BASE_RADIUS_RANGE,
	DEPTH_SPACING_RANGE,
	DEPTH_STRENGTH_RANGE,
	DEFAULT_RENDER_SETTINGS,
	EDGE_WIDTH_LADDER,
	GRAVITY_RANGE,
	LABEL_SIZE_LADDER,
	LABEL_ZOOM_LADDER,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	NODE_SIZE_LADDER,
	REGION_BITMAP_OPTIONS,
	REGION_BLUR_LADDER,
	fromLadderPosition,
	toLadderPosition,
	REGION_DILATION_LADDER,
	REGION_EDGE_ALPHA_LADDER,
	VELOCITY_DECAY_RANGE,
	fromOffSliderPosition,
	fromSliderPosition,
	labelZoomDisplay,
	sanitizeRenderSettings,
	toOffSliderPosition,
	toSliderPosition,
} from "@/src/core";

/** The uniform node look (no state classes — canvas wants hex, not oklch): the accent color, until the state model lands. */
const NODE_COLOR_TOKEN = "--primary";

/** Per-device graph camera persistence (zoom+pan view state). */
const CAMERA_STORAGE_KEY = "lh.graph.camera.v1";

// ---- Render settings (the settings-panel controls) ------------------------ The shape, defaults, sanitizer

type RenderSettings = GraphRenderSettings;

/** Pure filter predicate for the search panel: a node is visible when the query is empty or matches its name or statement (case-insensitive). */
function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

/** In-place sessions patch for a live rename. */
function renameSessionsPatch(snapshot: Pick<GraphSnapshot, "sessions">, id: string, title: string): void {
	snapshot.sessions[id] = title;
}

/** Seed positions for nodes the ledger doesn't know yet: they used to fall through to a ?? */
function seedMissingNodePositions(
	nodes: readonly { id: string }[],
	positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
	if (positions.size === 0 || nodes.every((n) => positions.has(n.id))) return positions;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of positions.values()) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const radius = Math.max(maxX - minX, maxY - minY, 40) * 0.7 + 20;
	const missing = nodes.filter((n) => !positions.has(n.id));
	missing.forEach((n, i) => {
		// FNV-1a hash → [0,1) → angle; the golden-angle spiral offset both spreads collisions and staggers long paths deterministically.
		let h = 0x811c9dc5;
		for (let c = 0; c < n.id.length; c++) {
			h ^= n.id.charCodeAt(c);
			h = (h * 0x01000193) >>> 0;
		}
		const angle = ((h / 0xffffffff) * 2 * Math.PI + i * 2.39996323) % (2 * Math.PI);
		positions.set(n.id, {
			x: cx + Math.cos(angle) * radius,
			y: cy + Math.sin(angle) * radius,
		});
	});
	return positions;
}

// ---- Color helpers (canvas wants hex, not oklch) ---------------------------

/** Resolve a CSS variable (oklch in this app) to #rrggbb via the canvas. */
function cssColorToHex(css: string): string {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "#888888";
	ctx.fillStyle = css;
	ctx.fillRect(0, 0, 1, 1);
	const { data } = ctx.getImageData(0, 0, 1, 1);
	return `#${[data[0]!, data[1]!, data[2]!]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

function tokenHex(cssVar: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
	return value ? cssColorToHex(value) : "#888888";
}

// ---- Component ------------------------------------------------------------

interface Selection {
	node: GraphNode;
	/** The sources that touched this node: chat ids (deep-linkable sessions) and notes-source ids ("src_…" — imported files, static entries). */
	sourceIds: string[];
	/** Node position in container pixels (at click time; camera moves dismiss the card, so it never needs re-anchoring). */
	anchor: { x: number; y: number };
}

/** One labeled range row for the rendering-settings panel. */
/** Compact size display for the log sliders: "2", "1.6", "0.75". */
function sizeDisplay(v: number): string {
	return `${v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}`;
}

function SettingSlider({
	label,
	min,
	max,
	step,
	value,
	display,
	onChange,
	disabled,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	/** Value display override (e.g. "1.5×" for zoom) — defaults to the raw number. */
	display?: string;
	onChange: (v: number) => void;
	/** Dependency graying: children dim + lock when their parent toggle/mode is off — consistently across sections. */
	disabled?: boolean;
}) {
	return (
		<label className={`flex flex-col gap-1${disabled ? " opacity-40" : ""}`}>
			<span className="flex items-center justify-between text-[11px] text-muted-foreground">
				{label}
				<span className="tabular-nums">{display ?? value}</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				className="h-1.5 w-full accent-primary"
			/>
		</label>
	);
}




/** The rendering-settings gear + its collapsible panel: its own container at the top right, separate from the search box and the import button */
function GraphSettingsControl({
	settings,
	changeSettings,
}: {
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
}) {
	const [open, setOpen] = useState(false);
	// Click anywhere outside (or Escape) closes the panel — the root wraps button + panel, so the toggle itself keeps working.
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	return (
		<div ref={rootRef} className="relative">
			<Hint
				// User language — "rendering" is internal.
				label="Graph display settings"
				side="bottom"
			>
				<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`flex size-9 items-center justify-center rounded-xl border bg-card/85 shadow-lg backdrop-blur transition-colors hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				<SettingsIcon className="size-4" />
			</button>
			</Hint>
			{open && (
				// Viewport-capped + internally scrollable — the coverage dropdown's exact pattern
				<div className="absolute right-0 top-full mt-2 flex max-h-[60vh] w-72 flex-col rounded-xl border bg-card/85 p-2.5 shadow-lg backdrop-blur">
					<div className="flex flex-col gap-2 overflow-y-auto pr-2.5">
							{/* Size/zoom/region sliders: LADDER-mapped 0-100, step 10 (11 stops, every DEFAULT dead-center at 50, every value a nice number… */}
							<SettingSlider
								label="Node size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.nodeSize, NODE_SIZE_LADDER)}
								display={sizeDisplay(settings.nodeSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, nodeSize: fromLadderPosition(p, NODE_SIZE_LADDER) }))}
							/>
							<SettingSlider
								label="Edge width"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.edgeWidth, EDGE_WIDTH_LADDER)}
								display={sizeDisplay(settings.edgeWidth)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, edgeWidth: fromLadderPosition(p, EDGE_WIDTH_LADDER) }))}
							/>
							<SettingSlider
								label="Arrowhead size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.arrowLength, ARROW_LENGTH_LADDER)}
								display={sizeDisplay(settings.arrowLength)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, arrowLength: fromLadderPosition(p, ARROW_LENGTH_LADDER) }))}
							/>
							<SettingSlider
								label="Label size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelSize, LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.labelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelSize: fromLadderPosition(p, LABEL_SIZE_LADDER) }))}
							/>
							{/* Display is absolute (ratio / 0.5): "1×" is the default, dead-center. */}
							<SettingSlider
								label="Labels until zoom"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelZoom, LABEL_ZOOM_LADDER)}
								display={labelZoomDisplay(settings.labelZoom)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelZoom: fromLadderPosition(p, LABEL_ZOOM_LADDER) }))}
							/>
							{/* Regions: the blurred cluster tints. */}
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								Regions
							</span>
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Background colors</span>
								<input
									type="checkbox"
									checked={settings.regions.enabled}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, enabled: e.target.checked },
										}))}
										className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Dilation"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.dilation, REGION_DILATION_LADDER)}
								display={sizeDisplay(regionTuning.dilation)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, dilation: fromLadderPosition(p, REGION_DILATION_LADDER) },
									}))}
							/>
							<SettingSlider
								label="Blur"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.blur, REGION_BLUR_LADDER)}
								display={sizeDisplay(regionTuning.blur)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, blur: fromLadderPosition(p, REGION_BLUR_LADDER) },
									}))
								}
							/>
							<SettingSlider
								label="Edge alpha"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.edgeAlpha, REGION_EDGE_ALPHA_LADDER)}
								display={sizeDisplay(regionTuning.edgeAlpha)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, edgeAlpha: fromLadderPosition(p, REGION_EDGE_ALPHA_LADDER) },
									}))}
							/>
							<label
								className={`flex items-center justify-between gap-2 text-[11px] text-muted-foreground${!regionTuning.enabled ? " opacity-40" : ""}`}
							>
								<span>Bitmap resolution</span>
								<select
									disabled={!regionTuning.enabled}
									className="rounded-md border bg-background px-1.5 py-0.5 text-xs tabular-nums text-foreground"
									value={regionTuning.bitmap}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, bitmap: Number(e.target.value) },
										}))
									}
								>
									{REGION_BITMAP_OPTIONS.map((o) => (
										<option key={o} value={o}>
											{o}
										</option>
									))}
								</select>
							</label>
							{/* Cluster labels moved here 2026-09-16 (user: cluster stuff lives in the regions section). */}
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Cluster labels</span>
								<input
									type="checkbox"
									checked={settings.clusterLabels}
									onChange={(e) => changeSettings((cur) => ({ ...cur, clusterLabels: e.target.checked }))}
									className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Cluster label size"
								disabled={!settings.clusterLabels}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.clusterLabelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										clusterLabelSize: fromLadderPosition(p, CLUSTER_LABEL_SIZE_LADDER),
									}))}
							/>
						</div>
						{/* Physics: the live sim's forces. */}
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								Physics
							</span>
							<SettingSlider
								label="Node repulsion"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(-physicsTuning.chargeStrength, -CHARGE_RANGE.max, -CHARGE_RANGE.min)}
								display={`-${Math.round(-physicsTuning.chargeStrength)}`}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, chargeStrength: -fromSliderPosition(p, -CHARGE_RANGE.max, -CHARGE_RANGE.min) },
									}))}
							/>
							<SettingSlider
								label="Edge attraction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkStrength, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkStrength: fromSliderPosition(p, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Edge length"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkDistance, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkDistance)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkDistance: fromSliderPosition(p, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Central pull"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.gravity, GRAVITY_RANGE.min, GRAVITY_RANGE.max)}
								display={sizeDisplay(physicsTuning.gravity)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, gravity: fromSliderPosition(p, GRAVITY_RANGE.min, GRAVITY_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Cluster pull"
								min={0}
								max={100}
								step={5}
								value={toOffSliderPosition(physicsTuning.clusterPull, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max)}
								display={physicsTuning.clusterPull <= 0 ? "off" : sizeDisplay(physicsTuning.clusterPull)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, clusterPull: fromOffSliderPosition(p, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Friction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.velocityDecay, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max)}
								display={sizeDisplay(physicsTuning.velocityDecay)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, velocityDecay: fromSliderPosition(p, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max) },
									}))}
							/>
							{/* Depth anchor LAST: general forces first, then the mode + its conditional controls at the very bottom… */}
							<label className="flex items-center justify-between gap-2 text-xs">
								Depth anchor
								<select
									className="rounded border bg-background px-1 py-0.5 text-xs"
									value={physicsTuning.depthMode}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											physics: { ...cur.physics, depthMode: e.target.value as GraphRenderSettings["physics"]["depthMode"] },
										}))
									}
								>
									<option value="off">Off</option>
									<option value="vertical">Vertical (up)</option>
									<option value="radial">Radial (outward)</option>
								</select>
							</label>
							<SettingSlider
								label="Depth strength"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthStrength, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthStrength: fromSliderPosition(p, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Depth spacing"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthSpacing, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthSpacing)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthSpacing: fromSliderPosition(p, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Base ring radius"
								disabled={physicsTuning.depthMode !== "radial"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthBaseRadius, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthBaseRadius)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthBaseRadius: fromSliderPosition(p, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max) },
									}))}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** The top-chrome actions row's body: Import Notes renders ALWAYS (graph enabled) — it's the one action that works on an empty graph */
function GraphChromeRow({
	isEmpty,
	query,
	onQuery,
	noMatch,
	importing,
	searchInputRef,
	fileInputRef,
	onImportFiles,
	settings,
	changeSettings,
	onOpenChains,
}: {
	isEmpty: boolean;
	query: string;
	onQuery: (v: string) => void;
	/** The search panel's "No matching nodes." note (computed by the wrapper — it owns visibleIds + the snapshot). */
	noMatch: boolean;
	importing: boolean;
	searchInputRef: React.RefObject<HTMLInputElement | null>;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	onImportFiles: (files: FileList | null) => void;
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
	/** Opens the chain table overlay. */
	onOpenChains: () => void;
}) {
	return (
		<>
			{!isEmpty && (
				<div className="graph-chrome-fade-in w-56 min-w-0 shrink rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<Hint
						// ⌘F focuses node search (surface-scoped registry action).
						label="Search nodes"
						action="find"
						side="bottom"
					>
					<div className="relative">
						<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							ref={searchInputRef}
							value={query}
							onChange={(e) => onQuery(e.target.value)}
							placeholder="Search nodes…"
							aria-label="Search nodes"
							spellCheck={false}
							className="h-7 w-full rounded-lg border bg-background pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
						/>
					</div>
					</Hint>
					{noMatch && (
						<div className="px-1.5 pt-1 text-[11px] text-muted-foreground">No matching nodes.</div>
					)}
				</div>
			)}
			{/* The chain table. */}
			{!isEmpty && (
				<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<Hint label="Every reasoning chain" side="bottom">
						<button
							type="button"
							onClick={onOpenChains}
							data-testid="open-chain-table"
							className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
						>
							<ListTreeIcon className="size-3" />
							Chains
						</button>
					</Hint>
				</div>
			)}
			{/* Import notes — its own container (36px, header band); ALWAYS rendered (the empty-graph ruling above — the entry point). */}
			<div className="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<input
					ref={fileInputRef}
					type="file"
					multiple
					accept=".md,.markdown,.txt"
					className="hidden"
					onChange={(e) => {
						onImportFiles(e.target.files);
						e.target.value = ""; // allow re-picking the same file
					}}
				/>
				<Hint
					// The one button whose action isn't obvious from its label: the missing fact is where imports go.
					label="Import notes into the graph"
					side="bottom"
				>
					<button
						type="button"
						disabled={importing}
						onClick={() => fileInputRef.current?.click()}
						data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
				>
						<UploadIcon className="size-3" />
						{importing ? "Importing…" : "Import notes…"}
					</button>
				</Hint>
			</div>
			{!isEmpty && (
				// Rendering settings — own component; the gear toggles it.
				<div className="graph-chrome-fade-in shrink-0">
					<GraphSettingsControl settings={settings} changeSettings={changeSettings} />
				</div>
			)}
		</>
	);
}

export function GraphView({
	chainSelectOpen = false,
	practiceSelection,
	onPracticeSelectionChange,
	onChainSelectClose,
}: {
	/** PRACTICE SELECT: the LIFTED, persistent pick set — every check/clear in the chain table (however opened) reports the full node list up immediately */
	chainSelectOpen?: boolean;
	practiceSelection?: ReadonlySet<string>;
	onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
	onChainSelectClose?: () => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [selected, setSelected] = useState<Selection | null>(null);
	// The latest snapshot for the renderer's click callbacks (they are constructed once, so they read through this ref, never a closure).
	const snapshotRef = useRef<GraphSnapshot | null>(null);
	snapshotRef.current = snapshot;

	// Search panel state: the query text + the settings section toggle.
	const [query, setQuery] = useState("");
	// ⌘F: the find event focuses the node search — surface-scoped, dispatched as lh:kbd-find (only this page listens).
	const searchInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const onFind = () => searchInputRef.current?.focus();
		window.addEventListener("lh:kbd-find", onFind);
		return () => window.removeEventListener("lh:kbd-find", onFind);
	}, []);
	// Render settings: SERVER-persisted (data/render-settings.json via /api/graph/render-settings) — sizes AND the region/physics sections.
	const [settings, setSettings] = useState<GraphRenderSettings>(DEFAULT_RENDER_SETTINGS);
	// The two nested sections, unpacked for the renderer feed effects below (same names the old session state had).
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	// True once the user has moved a control this mount: the server copy must never clobber a (possibly newer) local change.
	const userTouched = useRef(false);
	// True once the initial GET settled — saves are held back until then, so merely mounting never PUTs defaults over the server copy.
	const serverLoaded = useRef(false);
	const savePending = useRef(false);
	const changeSettings = (update: (cur: RenderSettings) => RenderSettings) => {
		userTouched.current = true;
		setSettings(update);
	};
	const saveToServer = (s: RenderSettings) => {
		fetch("/api/graph/render-settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(s),
		}).catch((err) => console.error("[graph] settings save failed:", err));
	};
	useEffect(() => {
		fetch("/api/graph/render-settings")
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
			.then((raw) => {
				// Apply only if the user hasn't already moved a slider — if they outran the network, their change wins.
				if (raw !== null && !userTouched.current) setSettings(sanitizeRenderSettings(raw));
			})
			.catch(() => {
				// server unreachable → in-memory defaults keep working
			})
			.finally(() => {
				serverLoaded.current = true;
				// A change made during the fetch was held back — send now.
				if (savePending.current) {
					savePending.current = false;
					saveToServer(settingsRef.current);
				}
			});
	}, []);
	useEffect(() => {
		if (!userTouched.current) return; // mount-run / server-apply: no save
		if (!serverLoaded.current) {
			savePending.current = true; // hold until the GET settles
			return;
		}
		const id = setTimeout(() => saveToServer(settings), 400);
		return () => clearTimeout(id);
	}, [settings]);

	// The renderer instance lives across snapshot refetches and settings changes (its camera is never reset by either)
	const rendererRef = useRef<GraphCanvasRenderer | null>(null);
	const posRef = useRef<Map<string, { x: number; y: number }> | null>(null);

	// The id set that survives the current search — consumed by the visibility feed and the "no matches" hint.
	const visibleIds = useMemo(() => {
		const set = new Set<string>();
		if (snapshot)
			for (const node of snapshot.nodes) {
				if (isNodeVisible(node, query)) set.add(node.id);
			}
		return set;
	}, [snapshot, query]);

	// Fetch the derived graph.
	const [refreshTick, setRefreshTick] = useState(0);
	// The chain table overlay — component-local: a browsing surface, not graph state.
	const [chainsOpen, setChainsOpen] = useState(false);
	// PRACTICE SELECT: the parent's chip drives the select mode
	useEffect(() => {
		if (chainSelectOpen) setChainsOpen(true);
	}, [chainSelectOpen]);
	useEffect(() => {
		let cancelled = false;
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then((data) => {
				if (!cancelled) setSnapshot(data);
			})
			.catch((err) => console.error("[graph] fetch failed:", err));
		return () => {
			cancelled = true;
		};
	}, [refreshTick]);

	// Notes import (the format-agnostic front door): file picker → POST /api/graph/import; the runs surface in the status chips below
	const fileInputRef = useRef<HTMLInputElement>(null);
	// The dock's start-site nudge: the import POST awaits the WHOLE pipeline server-side, so the run registers long before the response
	const refreshActivity = useActivity().refresh;
	const notesImport = useNotesImport({
		onStart: () => {
			refreshActivity();
			setTimeout(() => refreshActivity(), 600);
		},
	});
	const { importing, onImportFiles } = notesImport;

	// Background pipeline status: read /api/graph/status; whenever a run LEAVES the feed (finished / aborted / failed), refetch the graph.
	const [pipelineRuns, setPipelineRuns] = useState<{ id: string; chatId: string; title: string; phase: string; startedAt: number }[]>([]);
	const rowIdsRef = useRef<Set<string>>(new Set());
	const readPipelineStatus = useCallback(() => {
		fetch("/api/graph/status")
			.then((res) => res.json() as Promise<{ runs: typeof pipelineRuns }>)
			.then(({ runs }) => {
				setPipelineRuns(runs);
				const ids = new Set(runs.map((r) => r.id));
				if ([...rowIdsRef.current].some((id) => !ids.has(id))) setRefreshTick((t) => t + 1);
				rowIdsRef.current = ids;
			})
			.catch(() => {}); // status is cosmetic — never surface read errors
	}, []);
	// PUSH: the standing 2s poll is RETIRED — the extraction registry announces every phase transition and every finish (activity-changed)
	const statusDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useServerEvent("activity-changed", () => {
		if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
		statusDebounceRef.current = setTimeout(() => {
			statusDebounceRef.current = undefined;
			readPipelineStatus();
		}, 250);
	});
	useServerResync(() => readPipelineStatus());
	useEffect(() => {
		readPipelineStatus();
		return () => {
			if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
		};
	}, [readPipelineStatus]);

	/* Deletion refresh: the DELETE /api/chats/:id response carries the new graphRevision */
	useEffect(() => {
		const onRevision = () => setRefreshTick((t) => t + 1);
		window.addEventListener("lh:graph-revision", onRevision);
		return () => window.removeEventListener("lh:graph-revision", onRevision);
	}, []);

	/* Live rename labels: a session rename anywhere (sidebar inline row, chat header) announces itself as lh:chat-renamed {id, title} */
	const [, setLabelTick] = useState(0);
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id?: string; title?: string }>).detail ?? {};
			if (typeof id !== "string" || typeof title !== "string" || id === "" || title === "") return;
			const snap = snapshotRef.current;
			if (snap != null) renameSessionsPatch(snap, id, title);
			rendererRef.current?.setClusterLabels(new Map([[id, title]]));
			setLabelTick((t) => t + 1);
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	// The node context menu (node interlude): right-click a node → Delete.
	const [ctxNode, setCtxNode] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
	const ctxAnchorRef = useRef<HTMLDivElement | null>(null);
	const [deletingNode, setDeletingNode] = useState<{ id: string; name: string } | null>(null);
	useEffect(() => {
		if (ctxNode === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxNode(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxNode(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxNode]);

	// Layout (Option A): the positions ledger (written by the server's incremental settle after every merge) IS the layout
	useEffect(() => {
		if (!snapshot || snapshot.nodes.length === 0) return;
		// The ledger path: every positioned node uses its resting position
		const ledger = snapshot.positions;
		if (ledger) {
			const positions = new Map<string, { x: number; y: number }>();
			for (const node of snapshot.nodes) {
				const p = ledger[node.id];
				if (p) positions.set(node.id, { x: p.x, y: p.y });
			}
			if (positions.size > 0) {
				// Hygiene: nodes the ledger doesn't know yet (raced mid-settle) get seeded ring positions instead of the old ??
				posRef.current = seedMissingNodePositions(snapshot.nodes, positions);
				return () => {
					posRef.current = null;
				};
			}
		}
		// Bootstrap fallback: the ledger is absent (fresh graph) — run the SAME engine the server settle uses (d3-force via incrementalLayout
		posRef.current = incrementalLayout(snapshot.nodes, snapshot.edges, new Map());
		return () => {
			posRef.current = null;
		};
	}, [snapshot]);

	// Construct the renderer once the canvas exists; destroy when it goes away (the empty-graph placeholder replaces it).
	const isEmpty = snapshot === null || snapshot.nodes.length === 0;
	useEffect(() => {
		if (isEmpty) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		// Persisted camera: the graph reopens exactly where the user left it — zoom AND pan, in localStorage (per-device view state
		let initialCamera: { k: number; x: number; y: number } | null = null;
		try {
			const stored = localStorage.getItem(CAMERA_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored) as { k?: unknown; x?: unknown; y?: unknown };
				if (
					typeof parsed.k === "number" && Number.isFinite(parsed.k) && parsed.k > 0 &&
					typeof parsed.x === "number" && Number.isFinite(parsed.x) &&
					typeof parsed.y === "number" && Number.isFinite(parsed.y)
				)
					initialCamera = { k: parsed.k, x: parsed.x, y: parsed.y };
			}
		} catch {
			// Corrupt entry → treat as absent; the renderer fits.
		}
		// Debounced camera writes: a pan emits hundreds of transforms per second; one trailing write per quiet spell is plenty.
		let cameraTimer: ReturnType<typeof setTimeout> | null = null;
		let lastCamera: { k: number; x: number; y: number } | null = null;
		const persistCamera = (t: { k: number; x: number; y: number }) => {
			lastCamera = t;
			if (cameraTimer) clearTimeout(cameraTimer);
			cameraTimer = setTimeout(() => {
				cameraTimer = null;
				try {
					localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(t));
				} catch {
					// Storage full/blocked: camera persistence is best-effort.
				}
			}, 250);
		};
		const renderer = new GraphCanvasRenderer(
			canvas,
			{
				onSelect: (nodeId, pos) => {
					const snap = snapshotRef.current;
					const node = snap?.nodes.find((n) => n.id === nodeId);
					if (!snap || !node) return;
					setSelected({
						node,
						sourceIds: snap.nodeSessions[node.id] ?? [],
						anchor: pos,
					});
				},
				onStageClick: () => setSelected(null),
				// Right-click → the node context menu (node interlude).
				onContext: (nodeId, pos) => {
					if (nodeId === null) {
						setCtxNode(null);
						return;
					}
					const node = snapshotRef.current?.nodes.find((n) => n.id === nodeId);
					if (!node) return;
					setCtxNode({ id: node.id, name: node.name, x: pos.x, y: pos.y });
				},
				// Any camera move detaches the card from its node — close it, and (debounced) remember where the camera stands.
				onCameraMove: (t) => {
					setSelected(null);
					setCtxNode(null);
					persistCamera(t);
				},
				// Live physics settled: persist the new rest state.
				onCommit: (positions) => {
					void fetch("/api/graph/positions", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(positions),
					}).catch((err) => console.error("[graph] positions commit failed", err));
				},
			},
			initialCamera,
		);
		rendererRef.current = renderer;
		return () => {
			rendererRef.current = null;
			// Flush a pending camera write so an unmount <250ms after a move still persists the user's last standpoint.
			if (cameraTimer && lastCamera) {
				clearTimeout(cameraTimer);
				cameraTimer = null;
				try {
					localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(lastCamera));
				} catch {
					// best-effort
				}
			}
			renderer.destroy();
		};
	}, [isEmpty]);

	// Feed #1 — data: positions + edges + clusters + resolved colors.
	useEffect(() => {
		const renderer = rendererRef.current;
		const positions = posRef.current;
		if (!renderer || !snapshot || snapshot.nodes.length === 0 || !positions) return;
		renderer.setData({
			nodes: snapshot.nodes.map((n) => ({
				id: n.id,
				x: positions.get(n.id)?.x ?? 0,
				y: positions.get(n.id)?.y ?? 0,
				label: n.name,
			})),
			edges: snapshot.edges.map((e) => ({ from: e.from, to: e.to })),
			logicalEdges: snapshot.logicalEdges.map((e) => ({ from: e.from, to: e.to })),
			impLinks: snapshot.impLinks,
			clusters: snapshot.clusters.map((c) => ({ id: c.id, label: c.label, members: c.members })),
			colors: {
				node: tokenHex(NODE_COLOR_TOKEN),
				edge: tokenHex("--ring"),
				label: tokenHex("--muted-foreground"),
				hoverText: tokenHex("--foreground"),
			},
			// Match the app typography (Geist via the body's stack).
			fontFamily: getComputedStyle(document.body).fontFamily,
		});
	}, [snapshot, isEmpty]);

	// Feed #2 — settings: just marks the frame dirty.
	const deferredSettings = useDeferredValue(settings);
	useEffect(() => {
		rendererRef.current?.setSettings(deferredSettings);
	}, [deferredSettings, isEmpty]);

	// Feed #3 — visibility: hidden nodes drop out of rendering, picking, hover, AND labels; edges drop when either endpoint is hidden.
	useEffect(() => {
		rendererRef.current?.setVisible(query.trim() ? visibleIds : null);
		// The open detail card cannot outlive its node's visibility.
		setSelected((sel) => (sel && visibleIds.has(sel.node.id) ? sel : null));
	}, [visibleIds, query]);

	// Feed #4 — region tuning.
	useEffect(() => {
		rendererRef.current?.setRegionTuning(regionTuning);
	}, [regionTuning, isEmpty]);

	// Feed #5 — physics tuning: rebuilds the live sim in place (drag pins survive; a mid-settle change re-anneals, the honest response).
	useEffect(() => {
		rendererRef.current?.setPhysicsTuning(physicsTuning);
	}, [physicsTuning, isEmpty]);

	// Position the detail card: below the clicked node, flipped above near the bottom edge, clamped horizontally.
	useLayoutEffect(() => {
		const card = cardRef.current;
		const container = containerRef.current;
		if (!selected || !card || !container) return;
		const width = card.offsetWidth;
		const height = card.offsetHeight;
		const margin = 8;
		const gap = 12;
		const left = Math.min(
			Math.max(selected.anchor.x - width / 2, margin),
			Math.max(container.clientWidth - width - margin, margin),
		);
		let top = selected.anchor.y + gap;
		if (top + height > container.clientHeight - margin) {
			top = Math.max(selected.anchor.y - gap - height, margin);
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.visibility = "visible";
	}, [selected]);

	return (
		<div className="relative h-full w-full">
			{isEmpty ? (
				// The empty graph keeps the first action clear without zero-valued statistics.
				<div className="flex h-full w-full items-center justify-center px-4">
					<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
						<WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
						<div className="text-lg font-medium text-foreground">Knowledge graph</div>
						<p className="max-w-sm text-sm">
							Start a session or import notes to build your graph.
						</p>
					</div>
				</div>
			) : (
				<div ref={containerRef} className="relative h-full w-full">
					{/* THE single canvas: every layer (hulls, edges, nodes, both label systems, hover) draws into it, once per frame. */}
					<canvas ref={canvasRef} className="block h-full w-full touch-none" />
					{/* The context menu's anchor: a zero-size point at the right-click position (canvas-relative == container-relative, the canvas fills this div). */}
					{ctxNode !== null && (
						<div
							ref={ctxAnchorRef}
							style={{ position: "absolute", left: ctxNode.x, top: ctxNode.y, width: 0, height: 0 }}
						/>
					)}
				</div>
			)}

			{/* The node context menu (node interlude): Delete is its one action (the same MenuShell discipline as the sidebar's session menu — placement, focus… */}
			{ctxNode !== null && (
				<MenuShell
					anchorRef={ctxAnchorRef}
					testid="node-context-menu"
					preferredSide="down"
					menuClass="flex w-fit flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<button
						type="button"
						data-testid="ctx-node-delete"
						onClick={() => {
							setDeletingNode({ id: ctxNode.id, name: ctxNode.name });
							setCtxNode(null);
						}}
						className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
					>
						Delete
					</button>
				</MenuShell>
			)}

			{/* The full-death confirm dialog (node interlude) — portaled to body by the component itself, lives here for state locality. */}
			<DeleteNodeDialog
				nodes={deletingNode ? [deletingNode] : null}
				onClose={() => setDeletingNode(null)}
				onDeleted={(nodeIds, graphRevision) => {
					// Close the dialog; close the detail card if it pointed here (the refetch would close it anyway
					setDeletingNode(null);
					if (selected && nodeIds.includes(selected.node.id)) setSelected(null);
					// The wave-6 chain: every listener refetches on this.
					window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { graphRevision } }));
				}}
			/>



			{/* Legend + filters: search box and per-state toggle rows. */}
			{/* Top-right controls — separate floating containers. */}
			{/* Header band: the controls sit IN the header's visual row — top-2 aligns with the sidebar toggle's band (header py-2, toggle h-9)… */}
			<div className="lh-no-drag lh-wco-floating absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
			{/* z-20: the row paints above the cost number below it — without this, the later-in-DOM cost control layered over the settings/coverage dropdowns… */}
			<div className="relative z-20 flex min-w-0 items-start gap-2">
				{/* The actions row: Import Notes always — the empty graph's entry point; search + settings only when nodes exist, fading in on their mount. */}
				<GraphChromeRow
					isEmpty={isEmpty}
					query={query}
					onQuery={setQuery}
					noMatch={snapshot !== null && visibleIds.size === 0 && query.trim() !== ""}
					importing={importing}
					searchInputRef={searchInputRef}
					fileInputRef={fileInputRef}
					onImportFiles={onImportFiles}
					settings={settings}
					changeSettings={changeSettings}
					onOpenChains={() => setChainsOpen(true)}
				/>
			</div>

			<NotesImportErrors errors={notesImport.errors} />
			{/* Top-right tail: the pipeline cost number — just a number, hover-highlighted, dropdown breakdown — then the running-pipeline pills under it. */}
			{pipelineRuns.map((run) => (
				<div
					key={run.id}
					className="flex items-center gap-2 rounded-full border bg-card/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
				>
					<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
					<span className="capitalize">{run.phase}</span>
					<span className="max-w-48 truncate text-foreground">{run.title}</span>
					<span className="tabular-nums">{Math.max(0, Math.round((Date.now() - run.startedAt) / 1000))}s</span>
				</div>
			))}
			</div>

			{selected && !isEmpty && (
				<div
					ref={cardRef}
					// Positioned imperatively in the layout effect above; hidden until placed so the flip never flashes in the wrong spot.
					style={{ visibility: "hidden", left: 0, top: 0 }}
					// lh-no-drag: the card is placed anywhere on the canvas — when it lands in the top strip it must stay interactive over home.tsx's drag surface.
					className="lh-no-drag absolute z-10 w-80 max-w-[calc(100%-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
				>
					<div className="text-sm font-medium leading-snug">{selected.node.name}</div>
					<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.statement}</div>
					{selected.sourceIds.length > 0 ? (
						<div className="mt-3 flex flex-col gap-1">
							<div className="text-xs text-muted-foreground">Sessions</div>
							{selected.sourceIds.map((sourceId) => {
								// An imported-notes file: a STATIC entry — the path, plain text, never a link (no session to open).
								if (snapshot?.fileSources?.[sourceId] !== undefined) {
									return (
										<div key={sourceId} className="flex items-center gap-1.5">
											<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">
												{snapshot.fileSources[sourceId]}
											</span>
										</div>
									);
								}
								// A real session: deep-linkable provenance.
								return (
									<div key={sourceId} className="flex items-center gap-1.5">
										<Link
											href={propositionSessionHref(selected.node, sourceId)}
											scroll={false}
											className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
										>
											{snapshot?.sessions[sourceId] ?? sourceId}
										</Link>
									</div>
								);
							})}
						</div>
					) : (
						<div className="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
					)}
				</div>
			)}
			{/* The chain table overlay: ABSOLUTE INSIDE the graph area (the session-overlay idiom… */}
			<ChainTableOverlay
				open={chainsOpen && !isEmpty}
				nodes={snapshot?.propositions ?? []}
				chains={snapshot?.chains ?? []}
				sessions={snapshot?.sessions ?? {}}
				fileSources={snapshot?.fileSources ?? {}}
				onClose={() => {
					setChainsOpen(false);
					onChainSelectClose?.();
				}}
				selectMode={chainSelectOpen}
				controlledSelection={practiceSelection}
				onSelectionChange={(ids) => {
					// Resolve ids → nodes against the live snapshot; the caller holds the pick set (count + seed).
					const props = snapshot?.propositions ?? [];
					const picked: { id: string; name: string; statement: string }[] = [];
					for (const id of ids) {
						const n = props.find((node) => node.id === id);
						if (n) picked.push({ id: n.id, name: n.name, statement: n.statement });
					}
					onPracticeSelectionChange?.(picked);
				}}
			/>		</div>
	);
}
