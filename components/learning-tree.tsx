"use client";

/**
 * The learning tree canvas (owner 2026-10-29) — the Planner page's map of
 * everything the learner studies (src/server/claude/learning-tree.ts).
 * Layered top-down like the lesson plan maps (the same dagre placement,
 * blockLayout); a topic shared across purviews is ONE box with an edge from
 * each parent. Read-only: the planner and the tutors change the tree; here
 * the learner pans, zooms, collapses branches, and opens sessions.
 *
 * Status colors the box (todo gray, learning yellow, done green; a group
 * shows its leaves' progress), kind shapes it (group bold, practice
 * dashed). Re-read every few seconds so the agents' edits appear live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CodeIcon, MaximizeIcon, MessageSquareIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { curveBasis, line } from "d3-shape";
import { cn } from "@/lib/utils";
import { blockLayout, LINE_H, NODE_H, NODE_W_MIN, wrapTitle } from "@/components/plan-block";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";

type TreeKind = "group" | "concept" | "practice";
type TreeStatus = "todo" | "learning" | "done";
interface TreeNode {
	id: string;
	title: string;
	kind: TreeKind;
	status: TreeStatus;
	parents: string[];
	source?: string;
	note?: string;
	sessions: string[];
	workspace?: string;
}
interface TreeData {
	nodes: TreeNode[];
	sessions: Record<string, { title: string; kind: string }>;
}

const POLL_MS = 3000;
const PAD = 24;
const COLLAPSED_KEY = "lh-tree-collapsed";

const edgeLine = line<{ x: number; y: number }>()
	.x((p) => p.x)
	.y((p) => p.y)
	.curve(curveBasis);

// ─── pure helpers (exported for tests) ──────────────────────────────────────

export function childMap(nodes: readonly TreeNode[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const n of nodes) for (const p of n.parents) out.set(p, [...(out.get(p) ?? []), n.id]);
	return out;
}

/** A group's status from the topics under it: done when every one is
 *  done, learning once any has started; other nodes carry their own. */
export function shownStatus(nodes: readonly TreeNode[], id: string, children = childMap(nodes)): TreeStatus {
	const byId = new Map(nodes.map((n) => [n.id, n] as const));
	const node = byId.get(id);
	if (!node || node.kind !== "group") return node?.status ?? "todo";
	const leaves = [...descendants(id, children)].map((d) => byId.get(d)!).filter((n) => n && n.kind !== "group");
	if (leaves.length === 0) return node.status;
	if (leaves.every((n) => n.status === "done")) return "done";
	return leaves.some((n) => n.status !== "todo") ? "learning" : "todo";
}

function descendants(id: string, children: Map<string, string[]>): Set<string> {
	const out = new Set<string>();
	const queue = [...(children.get(id) ?? [])];
	while (queue.length > 0) {
		const next = queue.shift()!;
		if (out.has(next)) continue;
		out.add(next);
		queue.push(...(children.get(next) ?? []));
	}
	return out;
}

/** What shows with some branches collapsed: nodes reachable from a root
 *  without passing through a collapsed node, and the edges between them. */
export function visibleTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>) {
	const children = childMap(nodes);
	const shown = new Set<string>();
	const queue = nodes.filter((n) => n.parents.length === 0).map((n) => n.id);
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (shown.has(id)) continue;
		shown.add(id);
		if (!collapsed.has(id)) queue.push(...(children.get(id) ?? []));
	}
	const edges = nodes.flatMap((n) => (shown.has(n.id) ? n.parents.filter((p) => shown.has(p) && !collapsed.has(p)).map((p) => ({ from: p, to: n.id })) : []));
	return { shown, edges, children };
}

// ─── the canvas ─────────────────────────────────────────────────────────────

const BOX: Record<TreeStatus, string> = {
	todo: "fill-card stroke-border",
	learning: "fill-yellow-400/10 stroke-yellow-400/80",
	done: "fill-emerald-500/15 stroke-emerald-500/80",
};
const TEXT: Record<TreeStatus, string> = {
	todo: "fill-muted-foreground",
	learning: "fill-foreground",
	done: "fill-foreground",
};

function readCollapsed(): Set<string> {
	try {
		return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
	} catch {
		return new Set();
	}
}

export function LearningTree() {
	const router = useRouter();
	const [data, setData] = useState<TreeData | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const lastJson = useRef("");

	useEffect(() => setCollapsed(readCollapsed()), []);
	const read = useCallback(() => {
		fetch("/api/tree")
			.then((r) => r.text())
			.then((text) => {
				if (text === lastJson.current) return;
				lastJson.current = text;
				setData(JSON.parse(text) as TreeData);
			})
			.catch(() => {});
	}, []);
	useEffect(() => {
		read();
		const timer = setInterval(read, POLL_MS);
		return () => clearInterval(timer);
	}, [read]);

	const toggle = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			try {
				localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
			} catch {
				// a remembered view only
			}
			return next;
		});
	};

	const nodes = useMemo(() => data?.nodes ?? [], [data]);
	const view = useMemo(() => {
		const { shown, edges, children } = visibleTree(nodes, collapsed);
		const labelled = nodes
			.filter((n) => shown.has(n.id))
			.map((n) => {
				const hidden = collapsed.has(n.id) ? descendants(n.id, children).size : 0;
				return { id: n.id, title: hidden ? `${n.title} (+${hidden})` : n.title };
			});
		const status = new Map(nodes.map((n) => [n.id, shownStatus(nodes, n.id, children)] as const));
		return { labelled, edges, status, children };
	}, [nodes, collapsed]);
	const layout = useMemo(() => blockLayout(view.labelled, view.edges), [view]);
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);

	// ── pan/zoom (the plan popup's fit-floor semantics, pan-zoom.ts) ──
	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const box = useMemo(() => ({ w: layout.width + 2 * PAD, h: layout.height + 2 * PAD }), [layout]);
	const fitZoom = useMemo(() => fitZoomFor(box, size), [box, size]);
	const [cam, setCam] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
	const adjusted = useRef(false);
	const atFloor = cam.zoom <= fitZoom + 1e-9;
	useEffect(() => {
		if (atFloor) adjusted.current = false;
	}, [atFloor]);
	useEffect(() => {
		if (adjusted.current || !size.w || !size.h) return;
		setCam(fitGraphView(box, size, fitZoom));
	}, [fitZoom, size, box]);
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			const rect = el.getBoundingClientRect();
			setCam((v) => zoomedGraphView(v, Math.exp(-dy * 0.0015), fitZoom, { x: e.clientX - rect.left, y: e.clientY - rect.top }, box, size));
			adjusted.current = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [fitZoom, box, size]);

	const [panning, setPanning] = useState(false);
	const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
	const panned = useRef(false);
	const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, [data-tree-card]")) return;
		panned.current = false;
		if (atFloor) return;
		drag.current = { px: e.clientX, py: e.clientY, x: cam.x, y: cam.y, moved: false };
		setPanning(true);
	};
	const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		// Capture only once it is a real drag, so a click still reaches its node.
		if (!d.moved && Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 3) {
			d.moved = true;
			e.currentTarget.setPointerCapture(e.pointerId);
		}
		setCam((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
	};
	const endDrag = () => {
		if (drag.current?.moved) {
			adjusted.current = true;
			panned.current = true;
		}
		drag.current = null;
		setPanning(false);
	};
	const stepZoom = (factor: number) => {
		adjusted.current = true;
		setCam((v) => zoomedGraphView(v, factor, fitZoom, { x: size.w / 2, y: size.h / 2 }, box, size));
	};
	const fit = () => {
		adjusted.current = false;
		if (size.w && size.h) setCam(fitGraphView(box, size, fitZoom));
	};

	const newSession = async (id: string) => {
		const res = await fetch(`/api/tree/${encodeURIComponent(id)}/session`, { method: "POST" });
		const body = (await res.json().catch(() => ({}))) as { chatId?: string };
		if (body.chatId) router.push(`/chat/${body.chatId}`);
	};

	const card = selected ? byId.get(selected) : undefined;

	if (data === null) return <p className="px-6 py-4 text-xs text-muted-foreground">Loading the tree…</p>;
	if (nodes.length === 0) {
		return (
			<p className="px-6 py-4 text-sm text-muted-foreground">
				No learning tree yet. Ask the planner below to draft it from your documents.
			</p>
		);
	}

	return (
		<div
			ref={viewportRef}
			data-testid="learning-tree"
			className={cn("relative h-full w-full touch-none overflow-hidden select-none", atFloor ? "cursor-default" : panning ? "cursor-grabbing" : "cursor-grab")}
			onPointerDown={startDrag}
			onPointerMove={moveDrag}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onClick={(e) => {
				if (e.target === e.currentTarget && !panned.current) setSelected(null);
			}}
		>
			<div
				className="absolute top-0 left-0 origin-top-left"
				style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`, transition: panning ? "none" : "transform 180ms ease-out" }}
			>
				<svg
					viewBox={`${(layout.originX ?? 0) - PAD} ${(layout.originY ?? 0) - PAD} ${box.w} ${box.h}`}
					style={{ width: `${box.w}px`, fontFamily: "var(--font-prose)" }}
					className="block h-auto"
					role="img"
					aria-label="Learning tree"
				>
					{view.edges.map((e) => {
						const pts = layout.edgePts.get(`${e.from}->${e.to}`);
						const done = view.status.get(e.to) === "done";
						return pts ? <path key={`${e.from}->${e.to}`} d={edgeLine(pts) ?? ""} className={cn("fill-none", done ? "stroke-emerald-500/50" : "stroke-border")} strokeWidth={1} /> : null;
					})}
					{view.labelled.map((n) => {
						const node = byId.get(n.id)!;
						const status = view.status.get(n.id) ?? "todo";
						const lines = wrapTitle(n.title);
						const h = layout.nodeH.get(n.id) ?? NODE_H;
						const w = layout.nodeW.get(n.id) ?? NODE_W_MIN;
						const y0 = (h - lines.length * LINE_H) / 2 + 10;
						const group = node.kind === "group";
						return (
							<g
								key={n.id}
								transform={`translate(${layout.x.get(n.id) ?? 0}, ${layout.y.get(n.id) ?? 0})`}
								data-testid={`tree-node-${n.id}`}
								data-status={status}
								className="cursor-pointer"
								onClick={(e) => {
									e.stopPropagation();
									if (!panned.current) setSelected(n.id === selected ? null : n.id);
								}}
								onDoubleClick={(e) => {
									e.stopPropagation();
									if (view.children.has(n.id)) toggle(n.id);
								}}
							>
								<rect
									width={w}
									height={h}
									rx={group ? 0 : 6}
									className={cn(BOX[status], n.id === selected && "stroke-white")}
									strokeWidth={n.id === selected ? 2 : group ? 1.5 : 1}
									strokeDasharray={node.kind === "practice" ? "5 3" : undefined}
								/>
								{lines.map((text, i) => (
									<text key={i} x={w / 2} y={y0 + i * LINE_H} textAnchor="middle" className={cn("text-xs", TEXT[status], group && "font-semibold")}>
										{text}
									</text>
								))}
								{node.parents.length > 1 && <circle cx={w - 5} cy={5} r={2.5} className="fill-sky-400" aria-label={`under ${node.parents.length} parents`} />}
							</g>
						);
					})}
				</svg>
			</div>

			{card && (
				<div data-tree-card data-testid="tree-card" className="absolute top-3 right-3 z-10 flex w-80 flex-col gap-2 rounded-xl border border-border bg-card/95 p-3 text-sm shadow-lg backdrop-blur">
					<div className="flex items-start gap-2">
						<span className="min-w-0 flex-1 font-medium">{card.title}</span>
						<button type="button" aria-label="Close" onClick={() => setSelected(null)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
							<XIcon className="size-3.5" />
						</button>
					</div>
					<div className="text-xs text-muted-foreground">
						{card.kind} · {view.status.get(card.id) ?? card.status}
						{card.parents.length > 0 && <> · under {card.parents.map((p) => byId.get(p)?.title ?? p).join(", ")}</>}
					</div>
					{card.source && <div className="text-xs text-muted-foreground">Source: {card.source}</div>}
					{card.note && <div className="text-xs">{card.note}</div>}
					{card.workspace && <div className="font-mono text-[11px] break-all text-muted-foreground">{card.workspace}</div>}
					{card.sessions.length > 0 && (
						<ul className="flex flex-col gap-1">
							{card.sessions.map((s) => (
								<li key={s}>
									<a href={`/chat/${s}`} onClick={(e) => { e.preventDefault(); router.push(`/chat/${s}`); }} className="flex items-center gap-1.5 text-xs hover:underline">
										{data.sessions[s]?.kind === "code" ? <CodeIcon className="size-3.5" /> : <MessageSquareIcon className="size-3.5" />}
										{data.sessions[s]?.title ?? s}
									</a>
								</li>
							))}
						</ul>
					)}
					<div className="flex gap-2 pt-1">
						<button type="button" onClick={() => void newSession(card.id)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
							New session
						</button>
						{view.children.has(card.id) && (
							<button type="button" onClick={() => toggle(card.id)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
								{collapsed.has(card.id) ? "Expand" : "Collapse"}
							</button>
						)}
					</div>
				</div>
			)}

			<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-2">
				<span className="text-xs text-muted-foreground/60">Click a topic for details · double-click to collapse · drag to pan · scroll to zoom</span>
				<div className="flex gap-1">
					{[
						{ label: "Zoom out", icon: <MinusIcon className="size-3.5" />, run: () => stepZoom(1 / 1.25) },
						{ label: "Fit tree to screen", icon: <MaximizeIcon className="size-3.5" />, run: fit },
						{ label: "Zoom in", icon: <PlusIcon className="size-3.5" />, run: () => stepZoom(1.25) },
					].map((b) => (
						<button
							key={b.label}
							type="button"
							aria-label={b.label}
							title={b.label}
							onClick={b.run}
							className="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
						>
							{b.icon}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
