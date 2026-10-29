"use client";

/** MARKDOWN BLOCKS, MELTED INTO THE MESSAGE: the boxed streamdown chrome */

import { cloneElement, isValidElement, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, CopyIcon, MaximizeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	CodeBlock,
	extractTableDataFromElement,
	tableDataToMarkdown,
	useIsCodeFenceIncomplete,
} from "streamdown";
import type { ExtraProps } from "streamdown";
import { MERMAID_FONT_SIZE, renderMermaid } from "@/components/mermaid-render";
import { MermaidError } from "@/components/mermaid-error";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { chartSize, useSessionMermaid } from "@/components/session-overlay";
import { Hint } from "@/components/ui/hint";

// ─── The one affordance: the hover-reveal corner copy ────────────────────────

/** Clipboard write with a fallback: navigator.clipboard needs the `clipboard-sanitized-write` permission */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		/* fall through to the legacy path */
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

/** A small muted copy icon for a block's top-right corner. */
function CopyCorner({
	getText,
	label,
	className,
}: {
	getText: () => string;
	label: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timerRef.current), []);
	return (
		<span className={cn("relative inline-flex", className)}>
			<button
				type="button"
				aria-label={label}
				data-testid="md-copy"
				className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/md:opacity-100"
				onClick={(e) => {
					blurAfterPointerClick(e);
					void copyText(getText()).then((ok) => {
						if (!ok) return;
						setCopied(true);
						window.clearTimeout(timerRef.current);
						timerRef.current = window.setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
			</button>
		</span>
	);
}

// ─── Code + mermaid fences (the Streamdown `code` override) ──────────────────

/** The fence source from a code element's children — a bare string in the common case; an element wrapping a string when rehype nests it. */
function codeSource(children: ReactNode): string {
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (isValidElement(children)) {
		const inner = (children.props as { children?: ReactNode }).children;
		if (typeof inner === "string") return inner;
	}
	return "";
}

/** Mermaid, in the message flow: the bare chart (dark theme, rendered via the app's own plugin — components/mermaid-render.ts) */
function MermaidInline({ chart }: { chart: string }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const overlay = useSessionMermaid();
	const incomplete = useIsCodeFenceIncomplete();
	// The font-parity cap: the house CSS (`max-width: 100% !important`) overrides mermaid's own natural-size cap
	const holderRef = useRef<HTMLDivElement>(null);
	const [capW, setCapW] = useState<number | null>(null);
	useEffect(() => {
		if (!svg || !holderRef.current) return;
		const fs = Number.parseFloat(getComputedStyle(holderRef.current).fontSize);
		if (!Number.isFinite(fs) || fs <= 0) return;
		const { w } = chartSize(svg);
		setCapW((w * fs) / MERMAID_FONT_SIZE);
	}, [svg]);

	useEffect(() => {
		if (incomplete) return;
		let cancelled = false;
		setSvg(null);
		setError(null);
		renderMermaid(chart)
			.then((s) => {
				if (!cancelled) setSvg(s);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [chart, attempt, incomplete]);

	if (incomplete || (svg === null && error === null)) {
		return (
			<div data-testid="md-mermaid" className="my-4 flex justify-center p-4" aria-busy="true">
				<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
			</div>
		);
	}
	if (error !== null) {
		return <MermaidError chart={chart} error={error} retry={() => setAttempt((a) => a + 1)} />;
	}
	return (
		// data-streamdown="mermaid" keeps the house CSS hook (the svg max-width rule in globals.css) alive for this app-owned block.
		<div data-testid="md-mermaid" data-streamdown="mermaid" className="group/md relative my-4">
			<div
				ref={holderRef}
				className="mx-auto flex w-full justify-center"
				style={capW === null ? undefined : { maxWidth: `${capW}px` }}
				dangerouslySetInnerHTML={{ __html: svg ?? "" }}
			/>
			<div className="absolute top-0 right-0 flex items-start gap-0.5">
				<CopyCorner getText={() => chart} label="Copy diagram source" />
				{overlay && (
					<Hint
					// Full-screen overlay copy — "session view" was internal direction-speak for the same thing.
					label="Open full-screen"
					side="bottom"
				>
<button
						type="button"
						aria-label="Expand diagram"
						data-testid="md-mermaid-expand"
												className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/md:opacity-100"
						onClick={(e) => {
							blurAfterPointerClick(e);
							overlay.openMermaid(chart);
						}}
					>
						<MaximizeIcon className="size-3.5" />
					</button>
				</Hint>
				)}
			</div>
		</div>
	);
}

/** The Streamdown `code` override: inline code passes through with the house inline classes; block fences split */
function MarkdownCode(props: ComponentProps<"code"> & ExtraProps) {
	const incomplete = useIsCodeFenceIncomplete();
	const { children, className, node, ...rest } = props;

	// Inline code: no data-block (the pre handler stamps block fences only).
	if (!("data-block" in props)) {
		return (
			<code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)} data-streamdown="inline-code" {...rest}>
				{children}
			</code>
		);
	}

	const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
	const meta = (node?.properties?.metastring as string | undefined) ?? "";
	const source = codeSource(children);

	if (language === "mermaid") return <MermaidInline chart={source} />;

	const startMatch = /startLine=(\d+)/.exec(meta);
	const startLine = startMatch ? Number.parseInt(startMatch[1]!, 10) : undefined;
	const lineNumbers = !/\bnoLineNumbers\b/.test(meta);
	return (
		<div className="group/md relative" data-testid="md-code">
			<CopyCorner className="absolute top-1.5 right-2 z-10" getText={() => source} label="Copy code" />
			<CodeBlock
				code={source}
				language={language}
				className={className}
				isIncomplete={incomplete}
				startLine={startLine !== undefined && startLine >= 1 ? startLine : undefined}
				lineNumbers={lineNumbers}
			/>
		</div>
	);
}

// ─── Key-idea callouts (the Streamdown `blockquote` override) ────────────────

/** GitHub-style alert markers — the syntax the models already know from a million READMEs. */
const ALERT_MARKER_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

interface ParsedAlert {
	kind: string;
	/** The blockquote children with the marker line stripped — prose intact. */
	children: ReactNode;
}

const significant = (c: ReactNode) => c !== null && c !== undefined && c !== "" && !(typeof c === "string" && c.trim() === "");

/** The element's markdown tag — Streamdown wraps every block in its own styled component (MarkdownParagraph, …) */
function markdownTag(el: React.ReactElement): string | null {
	if (typeof el.type === "string") return el.type;
	const node = (el.props as { node?: { tagName?: string } }).node;
	return node?.tagName ?? null;
}

/** Pure: does this blockquote open with a GitHub alert marker? */
function parseAlertMarker(children: ReactNode): ParsedAlert | null {
	const list = Array.isArray(children) ? children : [children];
	const para = list.find(significant);
	if (!isValidElement(para) || markdownTag(para) !== "p") return null;
	const inner = (para.props as { children?: ReactNode }).children;
	const innerList = Array.isArray(inner) ? inner : [inner];
	const lead = innerList.find(significant);
	if (typeof lead !== "string") return null;
	const match = ALERT_MARKER_RE.exec(lead);
	if (!match) return null;
	const kind = match[1]!.toLowerCase();
	const stripped = lead.slice(match[0].length);
	// Rebuild the paragraph without the marker line; drop it entirely when the marker stood alone (nothing but the marker text in the paragraph).
	const leadIdxInner = innerList.indexOf(lead);
	const hasFollowing = innerList.some((c, i) => i > leadIdxInner && significant(c));
	let rebuiltPara: ReactNode = null;
	if (stripped.trim() !== "" || hasFollowing) {
		let rest = innerList.map((c) => (c === lead ? (stripped === "" ? null : stripped) : c));
		if (stripped === "") {
			// the hard-break <br> that ended the marker line is now leading junk
			while (rest.length && (rest[0] === null || (isValidElement(rest[0]) && markdownTag(rest[0]) === "br"))) rest = rest.slice(1);
		}
		rebuiltPara = cloneElement(para, {}, ...rest);
	}
	const leadIdx = list.indexOf(para);
	const restChildren = [...list.slice(0, leadIdx), ...(rebuiltPara ? [rebuiltPara] : []), ...list.slice(leadIdx + 1)];
	return { kind, children: restChildren };
}

/** The key-idea callout: SHARP corners, a white stroke, NO background, NO label, NO icon — just the outline. */
function MarkdownBlockquote(props: ComponentProps<"blockquote"> & ExtraProps) {
	const { children, node, ...rest } = props;
	const alert = parseAlertMarker(children);
	if (!alert) {
		// Plain quote — Streamdown's own styling, restored by hand
		return (
			<blockquote
				{...rest}
				className="my-4 border-l-4 border-muted-foreground/30 pl-4 text-muted-foreground italic"
				data-streamdown="blockquote"
			>
				{children}
			</blockquote>
		);
	}
	return (
		<div
			data-testid="md-callout"
			data-alert-kind={alert.kind}
			className="my-4 w-fit max-w-full border border-white px-4 py-3 [&> :first-child]:mt-0 [&> :last-child]:mb-0"
		>
			{alert.children}
		</div>
	);
}

// ─── Tables (the Streamdown `table` override) ────────────────────────────────

/** A plain PROSE table: no wrapper box, no button rows — just the table (streamdown's inner cells keep their padding/typography */
function MarkdownTable(props: ComponentProps<"table"> & ExtraProps) {
	const { children, node, ...rest } = props;
	const ref = useRef<HTMLTableElement>(null);
	return (
		<div className="group/md relative my-4" data-testid="md-table">
			<CopyCorner
				// Contained in the table's top-right corner.
				className="absolute top-1 right-1 z-10"
				label="Copy table"
				getText={() => (ref.current ? tableDataToMarkdown(extractTableDataFromElement(ref.current)) : "")}
			/>
			<div className="overflow-x-auto">
				<table
					ref={ref}
					// No text-sm here — the table text runs at the session prose size.
					className="w-full border-collapse"
					data-streamdown="table"
					{...rest}
				>
					{children}
				</table>
			</div>
		</div>
	);
}

// ─── Display math (the Streamdown `span` override) ────────────────────────────

/** KaTeX display equations are wrapped in a SPAN.katex-display (rehype-katex renders them as spans with display:block CSS — NOT divs */
function MathDisplay(props: ComponentProps<"span"> & ExtraProps) {
	const { children, className, node, ...rest } = props;
	const ref = useRef<HTMLSpanElement>(null);
	if (!className?.includes("katex-display")) {
		return (
			<span className={className} {...rest}>
				{children}
			</span>
		);
	}
	return (
		// BLOCK, not inline: the katex-display child is itself display:block (KaTeX's CSS)
		<span className="group/md relative block z-0" data-testid="md-math">
			<CopyCorner
				className="absolute top-0 right-0 z-10"
				label="Copy equation source"
				getText={() => ref.current?.querySelector("annotation")?.textContent ?? ""}
			/>
			<span ref={ref} className={className} {...rest}>
				{children}
			</span>
		</span>
	);
}

// ─── The stable override set (module identity: Streamdown is memoized) ────────

/** Bold as the REAL element: streamdown's default `strong` renders `<span class="font-semibold" data-streamdown= "strong">` */
function MarkdownStrong(props: ComponentProps<"strong"> & ExtraProps) {
	const { children, className, node, ...rest } = props;
	return (
		<strong data-streamdown="strong" className={className} {...rest}>
			{children}
		</strong>
	);
}

export const mdComponents = {
	code: MarkdownCode,
	table: MarkdownTable,
	span: MathDisplay,
	strong: MarkdownStrong,
	blockquote: MarkdownBlockquote,
};
