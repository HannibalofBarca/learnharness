import katex from "katex";

/** THE LaTeX glyph seam: UI connectors that want math symbols render the REAL LaTeX glyphs through KaTeX — the app's math engine */

/** Cached katex HTML per command — the glyph set is tiny and renderToString is pure; one render per command per process. */
const cache = new Map<string, string>();

/** The raw katex HTML for a LaTeX command (pure, sync — SSR-safe). */
function latexGlyphHtml(cmd: string): string {
	let html = cache.get(cmd);
	if (html === undefined) {
		html = katex.renderToString(cmd, { throwOnError: false, output: "html" });
		cache.set(cmd, html);
	}
	return html;
}

/** One rendered LaTeX glyph. */
export function LatexGlyph({
	cmd,
	testid,
	className,
}: {
	cmd: string;
	testid?: string;
	className?: string;
}) {
	return (
		<span
			data-testid={testid}
			aria-hidden="true"
			className={className}
			// katex.renderToString is the library's own trusted output (the same thing rehype-katex injects for markdown math).
			dangerouslySetInnerHTML={{ __html: latexGlyphHtml(cmd) }}
		/>
	);
}
