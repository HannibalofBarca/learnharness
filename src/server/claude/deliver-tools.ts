/** The background jobs, done by the tutor Claude (docs/claude-code-bridge.md §Background work): Claude researches */

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "../../core/agent-types.ts";
import { getHeadless, providerSafePng } from "../../agent/subagents/headless.ts";
import { buildSubagentSteer, type DemoResult, type JobKind, type PdfResult, type ResearchResult, type VisualResult } from "../../core/contracts.ts";
import { newMessageId, type LhMessage } from "../../core/native-messages.ts";
import { stores } from "../stores.ts";
import { startBridgeTurn } from "../chat-handler.ts";
import { validateArguments, type BridgeResult, type ListedTool } from "./tools.ts";

const researchInput = Type.Object({
	question: Type.String({ minLength: 1, description: "The question you researched." }),
	brief: Type.String({ minLength: 1, description: "The research brief (Markdown, LaTeX ok), citing sources inline." }),
	sources: Type.Array(Type.Object({ title: Type.String(), url: Type.String() }), { description: "The sources the brief rests on." }),
});
const pdfInput = Type.Object({
	path: Type.String({ minLength: 1, description: "The PDF's path as the learner gave it." }),
	question: Type.String({ minLength: 1, description: "What you needed from the document." }),
	brief: Type.String({ minLength: 1, description: "The brief, with page citations." }),
	pagesRead: Type.Array(Type.Integer({ minimum: 1 }), { description: "Pages you actually read." }),
});
const demoTestInput = Type.Object({
	html: Type.String({ minLength: 1, description: "The complete single-file HTML demo." }),
	probe: Type.Optional(Type.String({ description: "Optional JS expression evaluated in the page after load; its value is returned." })),
});
const demoInput = Type.Object({
	title: Type.String({ minLength: 1 }),
	brief: Type.String({ minLength: 1, description: "What the demo shows and how to use it." }),
	html: Type.String({ minLength: 1, description: "The complete single-file HTML demo (tested with test_demo)." }),
	notes: Type.Optional(Type.String()),
});
const visualPreviewInput = Type.Object({ svg: Type.String({ minLength: 1, description: "The complete SVG figure." }) });
const visualInput = Type.Object({
	brief: Type.String({ minLength: 1, description: "What the figure shows." }),
	svg: Type.String({ minLength: 1, description: "The complete SVG figure (checked with preview_visual)." }),
	notes: Type.Optional(Type.String()),
});

export const DELIVER_TOOLS: ListedTool[] = [
	{ name: "deliver_research", description: "Hand a research brief you produced (with WebSearch/WebFetch) to the learner as a research card.", inputSchema: researchInput },
	{ name: "deliver_pdf_brief", description: "Hand a brief of a learner's PDF (you read it with Read) to the learner as a PDF card, with page citations.", inputSchema: pdfInput },
	{ name: "test_demo", description: "Run a single-file HTML demo headlessly in Chrome and report console errors, page errors and failed requests. Fix and re-test until clean.", inputSchema: demoTestInput },
	{ name: "deliver_demo", description: "Deliver a tested interactive HTML demo into the lesson (it is re-tested; a failing demo is refused).", inputSchema: demoInput },
	{ name: "preview_visual", description: "Render an SVG figure and return the image so you can check it before delivering.", inputSchema: visualPreviewInput },
	{ name: "deliver_visual", description: "Deliver a checked SVG figure into the lesson.", inputSchema: visualInput },
];

const SCHEMAS: Record<string, ListedTool["inputSchema"]> = Object.fromEntries(DELIVER_TOOLS.map((t) => [t.name, t.inputSchema]));

/** Write the finished-job shape into a turn. */
function deliver(chatId: string, kind: JobKind, input: Record<string, unknown>, result: ResearchResult | DemoResult | VisualResult | PdfResult): BridgeResult {
	const agent = startBridgeTurn(chatId);
	if (!agent) return { text: "Could not open a turn for this session.", isError: true };
	const toolCallId = `toolu_lh_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
	const job = stores.jobStore.createJob({ kind, chatId, toolCallId, input });
	stores.jobStore.updateJob(job.id, { status: "done", activity: "finished", result, delivery: { kind: "result", status: "delivered" } });
	agent.push({
		id: newMessageId(),
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: kind, arguments: input }],
		api: "anthropic-messages",
		provider: "claude-code",
		model: "claude-code",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as never);
	agent.push({
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName: kind,
		content: [{ type: "text", text: `Delivered (job ${job.id}).` }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	} as never);
	agent.push(buildSubagentSteer(job, result) as unknown as LhMessage as never);
	return { text: `Delivered to the learner (job ${job.id}).` };
}

function headlessOrError(): ReturnType<typeof getHeadless> | BridgeResult {
	const headless = getHeadless();
	const reason = headless.unavailableReason();
	return reason ? { text: `Headless Chrome is unavailable: ${reason}`, isError: true } : headless;
}

function demoReport(run: { ok: boolean; consoleErrors: string[]; pageErrors: string[]; failedRequests: string[]; probeResult?: unknown }): string {
	const lines = [run.ok ? "The demo ran cleanly." : "The demo has problems:"];
	for (const [label, list] of [["Console errors", run.consoleErrors], ["Page errors", run.pageErrors], ["Failed requests", run.failedRequests]] as const) {
		if (list.length) lines.push(`${label}:\n${list.map((l) => `  - ${l}`).join("\n")}`);
	}
	if (run.probeResult !== undefined) lines.push(`Probe result: ${JSON.stringify(run.probeResult)}`);
	return lines.join("\n");
}

/** Handle a delivery tool call, or undefined when `name` is not one. */
export async function callDeliverTool(chatId: string, name: string, raw: unknown): Promise<BridgeResult | undefined> {
	const schema = SCHEMAS[name];
	if (!schema) return undefined;
	const checked = validateArguments({ name, parameters: schema } as AgentTool<any>, raw);
	if (!checked.ok) return { text: checked.error, isError: true };
	const args = checked.args as Record<string, never>;

	if (name === "deliver_research") {
		const { question, brief, sources } = args as unknown as { question: string; brief: string; sources: ResearchResult["sources"] };
		return deliver(chatId, "research", { question }, { brief, sources });
	}
	if (name === "deliver_pdf_brief") {
		const { path, question, brief, pagesRead } = args as unknown as { path: string; question: string; brief: string; pagesRead: number[] };
		return deliver(chatId, "pdf", { path, question }, { path, question, brief, pagesRead, pagesConsulted: pagesRead });
	}
	if (name === "test_demo" || name === "deliver_demo") {
		const headless = headlessOrError();
		if ("text" in headless) return headless;
		const { html, probe } = args as unknown as { html: string; probe?: string };
		let run;
		try {
			run = await headless.runDemo(html, probe ? { probe } : undefined);
		} catch (err) {
			return { text: `The demo could not run: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
		if (name === "test_demo") return { text: demoReport(run) };
		if (!run.ok) return { text: `Not delivered — fix the demo first.\n\n${demoReport(run)}`, isError: true };
		const { title, brief, notes } = args as unknown as { title: string; brief: string; notes?: string };
		return deliver(chatId, "demo", { title, brief }, { title, html, tested: true, ...(notes ? { notes } : {}) });
	}
	if (name === "preview_visual") {
		const headless = headlessOrError();
		if ("text" in headless) return headless;
		try {
			const png = providerSafePng(await headless.renderSvg((args as unknown as { svg: string }).svg));
			return { text: "Rendered figure attached. Check it carefully before delivering.", images: [{ data: png.toString("base64"), mimeType: "image/png" }] };
		} catch (err) {
			return { text: `The SVG could not render: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
	}
	if (name === "deliver_visual") {
		const { brief, svg, notes } = args as unknown as { brief: string; svg: string; notes?: string };
		return deliver(chatId, "visual", { brief }, { svg, ...(notes ? { notes } : {}) });
	}
	return undefined;
}
