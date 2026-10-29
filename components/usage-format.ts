/**
 * Money/token presentation helpers (wave-4 observability UI) — shared by the
 * activity dock and the stats bar. Pure; exported for tests.
 */

/** USD for cent-scale money: >= $1 keeps two decimals, smaller keeps four. */
function formatUsd(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

export function planCostLabel(dollars: number | null, subscription: boolean | string | readonly string[] | undefined, format = formatUsd): string {
	const labels = subscription === true ? ["ChatGPT"] : typeof subscription === "string" ? [subscription] : Array.isArray(subscription) ? [...new Set(subscription)] : [];
	return [...(dollars === null ? [] : [format(dollars)]), ...labels].join(" + ") || "—";
}

/** 38000 → "38k", 1234567 → "1.2M" — trimmed, never "38.0k". */
export function formatTokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(n);
}


