/** The app's ONE mermaid renderer: both the in-chat block (components/md-blocks.tsx) and the session-scoped focus overlay */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";

/** The chart's base font size (px) — mermaid sizes ALL text relative to this, so it's the number the display-width cap (md-blocks) divides by */
export const MERMAID_FONT_SIZE = 16;

// The app is dark-only (html.dark in the root layout) — diagrams render in mermaid's dark theme.
const mermaidTheme: MermaidConfig = {
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	fontSize: MERMAID_FONT_SIZE,
	securityLevel: "strict",
	theme: "dark",
};

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. */
export async function renderMermaid(chart: string): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidTheme).render(id, chart);
	return svg;
}
