/** Cluster color identity — pure presentation math for the knowledge-graph regions. */

export type Pt = { x: number; y: number };

/** Stable hue per cluster id (content-hash): the region keeps its color across reshuffles because the id only changes when the members do. */
export function clusterHue(id: string): number {
	let h = 0;
	for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
}
