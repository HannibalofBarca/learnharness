import { Type, type Static } from "typebox";
import type { AuditVerdicts, ExtractionStageUsage, SessionFindings } from "../../core/contracts.ts";
import type { DerivedGraph } from "../../core/graph.ts";
import { messageViewLines } from "../../core/coverage.ts";
import { failedOutputCallIds, type LhMessage } from "../../core/native-messages.ts";


/** The extraction view under the teacher-prose ruling: ONLY learner-facing teacher prose (text or send_to_user) — no learner messages, thinking */
export function proseView(
	messages: ReadonlyArray<LhMessage>,
	title?: string,
	failedOutputCalls: ReadonlySet<string> = failedOutputCallIds(messages),
): string {
	const lines = messages.flatMap((message) => messageViewLines(message, message.id, failedOutputCalls));
	const head = title && title.length > 0 ? `# ${title}\n\n` : "";
	return head + lines.join("\n\n");
}

// ─── the extractor ──────────────────────────────────────────────────────────

const propositionProps = {
	id: Type.String({ description: 'Local id: "p1", "p2", … — referenced by chains in this call.' }),
	name: Type.String({
		description:
			"A very short label — established terminology, the term the discipline itself uses, a glossary " +
			"headword a textbook would print ('Will to power', 'Divine command theory'). Not a sentence, " +
			"needn't be unique or self-contained: this becomes the node's global label in the graph.",
	}),
	statement: Type.String({
		description:
			"One true, self-contained, world-facing core idea at full precision. Never about the " +
			'learner, the teacher, or the reading: not "the learner understands X" but "X". A misconception ' +
			"enters as its TRUE correction.",
	}),
	aliases: Type.Optional(
		Type.Array(Type.String(), {
			description: "Verbatim phrasings the source used for the same proposition, if any.",
		}),
	),
};

// The extractor redesign: the extractor submits REASONING CHAINS — premises + conclusion — stored AS-IS.
const endpoint = (role: string) =>
	Type.String({
		description:
			`The id this ${role} — EITHER an existing graph idea id from THE GRAPH SO FAR in the prompt, ` +
			'verbatim ("n_…"), OR the local id of a proposition in this submission ("p1", …).',
	});

const chainSchema = Type.Object({
	premises: Type.Array(endpoint("premise uses"), {
		minItems: 1,
		description:
			"Premise ids used TOGETHER: they jointly entail the conclusion; independent reasons are separate chains.",
	}),
	conclusion: endpoint("conclusion is"),
});

// Weak-model tolerance: the old zod `.default([])` / `.default({ quiz
const propositionsDescription =
	"Only the NEW core ideas this stretch contributes — ideas the prompt's THE GRAPH SO FAR already " +
	"holds are referenced by id in chains, never restated here.";
const chainsDescription =
	"Every argument this stretch makes — including arguments that join new ideas to established " +
	"ones; conclusions reusable by id as premises of later chains; bare ideas (no argument) ride " +
	"the propositions list alone; pass [] when none — never omit the field.";

export const findingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(propositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

// THE SESSION EXTENSION: every session proposition carries a REQUIRED messageId — the anchor of the passage it came from
const sessionPropositionProps = {
	...propositionProps,
	messageId: Type.String({
		description:
			"The message id of the ONE passage in this stretch that most directly states or explains this " +
			'proposition — copy it EXACTLY from that passage\'s "TEACHER [id]" label.',
	}),
};

export const sessionFindingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(sessionPropositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

/** What the extractor SUBMITS (the redesign's wire shape) — propositions + chains. */
type FindingsSubmit = Static<typeof findingsSchema>;

/** The SESSION wire — the notes shape plus the REQUIRED messageId anchor on every proposition. */
type SessionFindingsSubmit = Static<typeof sessionFindingsSchema>;

// VERDICTS-ONLY: the auditor never alters the extractor's findings, so it does not restate them — links are its ENTIRE deliverable.
export const auditSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The proposition id from the findings ("p1", …).' }),
			linkTo: Type.String({
				description:
					"The id of the EXISTING graph node this proposition IS — your identity verdict. EQUIVALENCE BIAS (2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart.",
			}),
		}),
		{ description: "Identity verdicts — which findings propositions ARE existing graph nodes. A proposition absent from here = create a new node. Pass [] when none — never omit the field." },
	),
});


// ── the submit seam ── Every top-level field on each submit tool is REQUIRED

export function fillFindings<T extends { propositions: Array<{ aliases?: string[] }>; chains: unknown }>(
	raw: T,
): T {
	return {
		...raw,
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	};
}

/** The notes fill: the shared alias ??-fill PLUS the door's boundary — a stray messageId (the notes schema has none */
export function fillNotesFindings(raw: FindingsSubmit): FindingsSubmit {
	return fillFindings({
		...raw,
		propositions: raw.propositions.map((p) => {
			const stripped = { ...p } as typeof p & { messageId?: unknown };
			delete stripped.messageId;
			return stripped;
		}),
	});
}

/** The chain laws — the LOUD channel: runSubmitAgent turns a problem string into an error tool result and the model re-submits within its turns. */
export function validateFindingsChains(value: FindingsSubmit, existingIds: ReadonlySet<string>): string | null {
	const ids = new Set(value.propositions.map((p) => p.id));
	for (const chain of value.chains) {
		if (chain.premises.length === 0) {
			return "chains: premises must name at least one proposition — a proposition with no argument stays in the propositions list alone.";
		}
		const unknown = [...chain.premises, chain.conclusion].find((id) => !ids.has(id) && !existingIds.has(id));
		if (unknown !== undefined) {
			return `chains: "${unknown}" is neither a submitted proposition id nor an existing idea id from THE GRAPH SO FAR — every premise and conclusion must resolve.`;
		}
		if (chain.premises.includes(chain.conclusion)) {
			return "chains: a conclusion cannot be its own premise.";
		}
	}
	return null;
}

/** The SESSION anchor law: every proposition names a passage of the CURRENT batch — nonempty */
export function validateSessionAnchors(value: SessionFindingsSubmit, batchIds: ReadonlySet<string>): string | null {
	for (const p of value.propositions) {
		if (p.messageId.trim().length === 0) {
			return `propositions: "${p.id}" is missing its messageId — copy the message id from the brackets of the passage (TEACHER [id]) that most directly states or explains it.`;
		}
		if (!batchIds.has(p.messageId)) {
			return `propositions: "${p.id}" names messageId "${p.messageId}", which is not a passage of THIS stretch — copy the id from the brackets of one of this stretch's own TEACHER [id] passages.`;
		}
	}
	return null;
}

/** the wire IS the pipeline shape now: propositions + chains, no translation */
export const asSessionFindings = (
	raw: {
		propositions: Array<{ id: string; name: string; statement: string; aliases?: string[]; messageId?: string }>;
		chains: Array<{ premises: string[]; conclusion: string }>;
	},
): SessionFindings => ({
	propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	chains: raw.chains,
});

export function fillAudit(raw: Static<typeof auditSchema>): AuditVerdicts {
	return {
		links: raw.links,
	};
}

// ── the extractor's system prompt ── GOAL-FIRST, NO RULE ARMOR: the old doctrine's defensive lists (DROP lists, merge-your-own-output, name walls

/** The session-only anchor instruction: passages arrive labeled "TEACHER [id]" and every proposition must name the ONE passage it came from */
const SESSION_MESSAGE_ID_RULE =
	"For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";

const SESSION_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — a teaching " +
	"session, rendered as the teacher's prose in reading order — and report what it teaches as findings " +
	"for the learner's global knowledge graph, building on everything already extracted from this source.";

const NOTES_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — the " +
	"author's personal notes, rendered in reading order — and report what it teaches as findings for the " +
	"learner's global knowledge graph, building on everything already extracted from this source.";

const EXTRACTION_CORE = `THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The
source teaches by arguing — ideas worked out from other ideas, down to a foundation the rest stands on.
Your deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.
Each chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a
chain — where the real connection is historical or narrative (who argued what, how a debate or
exposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of
the graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing
how its conclusion follows from what is more established — do not submit connections that carry no
derivation.

The graph holds TRUE ideas about the world, nothing else — never anything about the learner, the
teacher, or this reading: not "the learner understands X" but X. A misconception enters as its TRUE
correction. Each statement is one self-contained idea at full precision.

Extract the load-bearing ideas of the subject — what a reference on it would teach — not the full run
of the discourse. An idea earns its place only when the source's arguments run through it — examples,
notation glosses, and restatements that no argument needs are not core ideas. Every idea must stand
alone for a reader who never saw this source: names and statements may not lean on the source's own
scaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this
document is organized is not knowledge — drop it.

When the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build
on it. Reference an existing idea by its id ("n_…") instead of restating it, and prefer chains that
lean on established conclusions as premises — derive new material from what is already derived. Do
not re-derive a conclusion the graph already holds unless the route is genuinely different.

SUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,
and every chain as premises + conclusion. A chain's premises and conclusion may be ids from this
submission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used
TOGETHER — independent arguments for the same conclusion are separate chains. A conclusion may
reappear, by id, as a premise of later chains. A bare idea that no argument uses rides the
propositions list alone. Include every field even when empty — "chains": [] when the source makes no
arguments. The tool's field descriptions carry the details.`;

export const EXTRACTOR_INSTRUCTIONS = `${SESSION_PREAMBLE}\n\n${EXTRACTION_CORE}\n\n${SESSION_MESSAGE_ID_RULE}`;
export const NOTES_EXTRACTOR_INSTRUCTIONS = `${NOTES_PREAMBLE}\n\n${EXTRACTION_CORE}`;

// ── the same-source digest ── Serialized digest-aware extraction REPLACED the spine stage.
export function sourceDigest(graph: DerivedGraph, sourceId: string): string {
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
	const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
	if (ours.length === 0 && ourChains.length === 0) return "";
	const lines: string[] = [];
	lines.push("THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):");
	for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
	if (ourChains.length > 0) {
		lines.push("DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):");
		for (const c of ourChains) {
			const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
			lines.push(`  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${names} ⇒ ${nameOf.get(c.conclusion) ?? c.conclusion}`);
		}
	}
	return lines.join("\n");
}

// ─── the auditor ───────────────────────────────────────────────────────────


export const AUDITOR_INSTRUCTIONS = `You are the linking stage of a learning application's extraction pipeline. An extractor
has read a source (a teaching session, or the author's personal notes) and reported findings: propositions and
their reasoning chains. You NEVER see the source itself — the extractor is fully trusted, and you do not re-check
its work. Your job is IDENTITY: connecting those findings to the CURRENT knowledge graph, preparing the merge.

You explore the graph through your tools: list_sessions, list_propositions, and find (glob over names +
statements + aliases; each hit also says which session it was born in). The graph is SMALL and FINITE — a handful of
sessions — and your job is done as soon as you have SEEN the plausible candidates. FOLLOW THIS PROCEDURE:

1. GROUND yourself first: call list_sessions ONCE. This one call shows the entire space — every session that ever
   contributed propositions, and how many. Now you know the extent of what you are searching; nothing is hidden.
2. READ the plausibly-related sessions: for each session whose topic could overlap these findings, call
   list_propositions — every proposition born there, with full statement text. A few calls and you have read
   every realistic identity candidate in the graph.
3. find is your targeted sweep: use it for phrasings, synonyms, and neighboring ideas the session reads made you
   wonder about — its hits point back at sessions you can read whole.
4. SUBMIT. Once every plausibly-related session has been read (and stray finds come back empty), you are DONE.
   Do not re-search ground you have already seen; more patterns over the same nodes are wasted work.

IDENTITY — links, per proposition:
- For each proposition: does an EXISTING node — one you have now SEEN — already state this same proposition?
- If yes: add { "id": <its proposition id>, "linkTo": <that node's id> } to "links". The session's phrasings join
  its aliases and its provenance; the node keeps its existing name.
- If no: add nothing — a new node is created with the extractor's name as its label.
- EQUIVALENCE BIAS (owner ruling): paraphrases, rewordings, and compressions of the same claim MERGE. When two
  statements are the same claim at different precision or from different angles, LINK them. Only genuinely distinct
  propositions — different claims about the world — stay apart. You are NOT guarding against wrong merges; you are
  hunting for right ones.

Your deliverable is ONLY the identity verdicts: "links". NEVER restate the propositions —
the merger already has them. You NEVER create relations between propositions — they come from the
extractor alone, and the batch connects to the existing graph ONLY through the equivalences you identify. Your
entire deliverable is ONE submit_review call.

Include the "links" field even when empty — "links": [] when nothing links. NEVER omit it because it is empty.`;

// ─── the pipeline status registry ─────────────────────────────────────────────

/** The pipeline phases, in order — what the home status endpoint shows.
 *  The post-batch embedding tail was its own phase (accuracy wave,
 *  2026-09-19) until wave 7 killed the embedder seam wholesale (this
 *  interlude) — birth-session clusters need no post-merge pass. The
 *  phases tell the truth about what the job is actually waiting on.
 *  "queued" (owner, 2026-09-28): the global extract semaphore — 3
 *  concurrent extractor calls process-wide; the job is waiting for an
 *  extract slot, not for the model.
 *  "waiting" (owner 2026-09-28): the serialized-audit gate — the job's
 *  audit+merge critical section is queued behind another job's; the
 *  extractor is done but the auditor may not start until the graph is
 *  stable. */
export type ExtractionPhase = "queued" | "extracting" | "waiting" | "auditing" | "merging";

/** One in-flight pipeline run. */
interface RunningExtraction {
	/** The SOURCE id (chat id / notes src id) — the payload's identity and the abort key. */
	chatId: string;
	/** PER-CHUNK JOBS: which chunk of how many this job is — present only when the source fanned out (n > 1). */
	part?: { i: number; n: number };
	/** Which front door the run came through — label + usage-persistence depend on it (chats bill their chat record; notes bill the source record). */
	kind: "chat" | "notes";
	/** Display label (the file path for notes imports); the status route falls back to the chat store for chat runs. */
	label?: string;
	phase: ExtractionPhase;
	startedAt: number;
	/** Live per-stage usage, accumulated as steps bill (the dock's cost / context-window blobs read this through /api/graph/status). */
	usage: {
		extractor?: ExtractionStageUsage;
		auditor?: ExtractionStageUsage;
	};
	/** True-cancellation handle (the dock's abort button): one controller per run, shared across phases; abort() cancels the in-flight model call. */
	controller: AbortController;
}

interface LhExtractionGlobal {
	__lhExtractionRuns?: {
		/** In-flight pipeline runs, keyed chatId (chat) / src id (notes). */
		running: Map<string, RunningExtraction>;
		/** The single-flight guard, shared by every pipeline instance. */
		inFlight: Set<string>;
		/** Last minted startedAt — kept monotonic so two runs starting in the same millisecond never collide on the usage idempotency key. */
		lastStartedAt: number;
	};
	/** The serialized-audit mutex: a FIFO promise chain — the audit+merge critical section runs one job at a time, process-wide. */
	__lhAuditLock?: { tail: Promise<void> };
	/** The EXTRACT SEMAPHORE: 3 concurrent extractor calls process-wide — the provider-facing rate stance (the import route's old 3-wide pool doctrine */
}

/** THE RUN REGISTRIES live on globalThis, not module level — the turn-liveness lesson: Next dev compiles each route entry as its own module instance */
function runs(): NonNullable<LhExtractionGlobal["__lhExtractionRuns"]> {
	const g = globalThis as typeof globalThis & LhExtractionGlobal;
	return (g.__lhExtractionRuns ??= { running: new Map(), inFlight: new Set(), lastStartedAt: 0 });
}

/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export function extractionStatuses(): RunningExtraction[] {
	return [...runs().running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** True cancellation of the in-flight run for a chat (the dock's abort button): the pending model call receives the signal */
export function abortExtraction(chatId: string): boolean {
	// PER-CHUNK JOBS: a source may own several registry entries (one per chunk/batch) — aborting the source aborts EVERY job of its fan-out.
	let found = false;
	for (const run of runs().running.values()) {
		if (run.chatId !== chatId) continue;
		run.controller.abort();
		found = true;
	}
	return found;
}
