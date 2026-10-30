/** The learning tree's organic radial layout: seeded outward from the roots by depth, then settled by a force simulation. Pure and deterministic. */

import { forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

interface LayoutInput {
	id: string;
	w: number;
	h: number;
}
interface Sim extends SimulationNodeDatum {
	id: string;
	w: number;
	h: number;
}

const RING = 140;
const TICKS = 120;

/** A stable 0..1 offset per id, so siblings sit at varied distances instead of crowding one ring. */
function jitter(id: string): number {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
	return (h >>> 0) / 4294967296;
}

export function radialLayout(nodes: readonly LayoutInput[], edges: ReadonlyArray<{ from: string; to: string }>) {
	const x = new Map<string, number>();
	const y = new Map<string, number>();
	const edgePts = new Map<string, Array<{ x: number; y: number }>>();
	if (nodes.length === 0) return { x, y, edgePts, width: 0, height: 0, originX: 0, originY: 0 };

	// Spanning tree by first-seen parent: each node's wedge is sized by the leaves under it.
	const ids = new Set(nodes.map((n) => n.id));
	const kids = new Map<string, string[]>();
	const hasParent = new Set<string>();
	for (const e of edges) {
		if (!ids.has(e.from) || !ids.has(e.to) || hasParent.has(e.to)) continue;
		hasParent.add(e.to);
		kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
	}
	const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
	const leaves = new Map<string, number>();
	const count = (id: string): number => {
		const c = kids.get(id) ?? [];
		const v = c.length ? c.reduce((s, k) => s + count(k), 0) : 1;
		leaves.set(id, v);
		return v;
	};
	const total = roots.reduce((s, r) => s + count(r), 0);
	const seed = new Map<string, { x: number; y: number }>();
	const place = (id: string, depth: number, a0: number, a1: number) => {
		const a = (a0 + a1) / 2;
		const r = depth * RING * (0.75 + 0.5 * jitter(id));
		seed.set(id, depth === 0 && roots.length === 1 ? { x: 0, y: 0 } : { x: Math.cos(a) * r, y: Math.sin(a) * r });
		let at = a0;
		for (const k of kids.get(id) ?? []) {
			const span = ((a1 - a0) * leaves.get(k)!) / leaves.get(id)!;
			place(k, depth + 1, at, at + span);
			at += span;
		}
	};
	let at = 0;
	for (const r of roots) {
		const span = (2 * Math.PI * leaves.get(r)!) / total;
		place(r, roots.length === 1 ? 0 : 1, at, at + span);
		at += span;
	}

	const sim: Sim[] = nodes.map((n) => ({ id: n.id, w: n.w, h: n.h, ...seed.get(n.id)! }));
	if (roots.length === 1) {
		const root = sim.find((s) => s.id === roots[0])!;
		root.fx = 0;
		root.fy = 0;
	}
	const big = (s: Sim) => Math.max(s.w, s.h) > 20;
	const links: SimulationLinkDatum<Sim>[] = edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ source: e.from, target: e.to }));
	forceSimulation(sim)
		.force("link", forceLink<Sim, SimulationLinkDatum<Sim>>(links).id((d) => d.id).distance((l) => {
				const t = l.target as Sim;
				return (big(t) ? 110 : 45) * (0.6 + 0.9 * jitter(t.id));
			}).strength(0.6))
		.force("charge", forceManyBody<Sim>().strength((d) => (big(d) ? -500 : -60)))
		.force("collide", forceCollide<Sim>((d) => Math.hypot(d.w, d.h) / 2 + 4))
		.alphaDecay(1 - Math.pow(0.001, 1 / TICKS))
		.stop()
		.tick(TICKS);

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const center = new Map<string, { x: number; y: number }>();
	for (const s of sim) {
		center.set(s.id, { x: s.x!, y: s.y! });
		x.set(s.id, s.x! - s.w / 2);
		y.set(s.id, s.y! - s.h / 2);
		minX = Math.min(minX, s.x! - s.w / 2);
		minY = Math.min(minY, s.y! - s.h / 2);
		maxX = Math.max(maxX, s.x! + s.w / 2);
		maxY = Math.max(maxY, s.y! + s.h / 2);
	}
	for (const e of edges) {
		const a = center.get(e.from);
		const b = center.get(e.to);
		if (a && b) edgePts.set(`${e.from}->${e.to}`, [a, b]);
	}
	return { x, y, edgePts, width: maxX - minX, height: maxY - minY, originX: minX, originY: minY };
}
