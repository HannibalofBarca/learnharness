import { Type, type Static } from "typebox";
import type { AuditVerdicts, ChatRecord, ExtractionStageUsage, SessionFindings } from "../../core/contracts.ts";
import type { DerivedGraph, EmissionStats } from "../../core/graph.ts";
import { messageViewLines } from "../../core/coverage.ts";
import { failedOutputCallIds, type LhMessage } from "../../core/native-messages.ts";

/**
 * The extraction pipeline (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27) — the sole graph writer. Three stages, one
 * orchestrator (the spine stage came and went, 2026-09-30: serialized
 * digest-aware extraction replaced it — the owner's live test showed
 * the post-hoc assembly pass added complexity without perceptible
 * gain; the extractor itself is the assembler now):
 *
 *   extractor (LLM)  the ONE stage that sees the raw source (a session
 *                    rendered as the teacher's prose — each passage
 *                    labeled with its ACTUAL message id, "TEACHER [id]",
 *                    owner 2026-10-13 — or a notes file verbatim, walked
 *                    in stretches) → submits NEW core ideas + reasoning
 *                    chains (owner redesign, 2026-09-30); a session
 *                    submit additionally carries each proposition's
 *                    messageId — the anchor the merger stamps into the
 *                    node's message-granular provenance (2026-10-13).
 *                    DIGEST-AWARE (2026-09-30 evening):
 *                    when the source already yielded material, the
 *                    prompt carries THE GRAPH SO FAR (that source's
 *                    propositions + chains, ids verbatim) and the
 *                    extractor builds on it — referencing existing ids
 *                    instead of restating, leaning on established
 *                    conclusions as premises. Stretches of one source
 *                    run SERIALLY (each extract reads every earlier
 *                    merge); tree-blind, FULLY TRUSTED — nothing
 *                    downstream re-checks it.
 *   auditor (LLM)    never sees the source. Its job is IDENTITY: for each
 *                    NEW proposition, linkTo an existing graph node or
 *                    create — decided by EXPLORING the graph through
 *                    tools (find / list_sessions / list_propositions),
 *                    not by an injected graph dump (context bloat,
 *                    owner 2026-09-27). Links are its ONLY deliverable
 *                    — it never mints edges (owner 2026-09-28: the
 *                    graph connects across sources solely through
 *                    identified equivalences). Input is PROPOSITIONS
 *                    only — never chains (owner 2026-09-30).
 *   merger (core)    mergeFindings() → deterministic ledger appends +
 *                    chain simplification (2026-09-30 evening: the
 *                    ancestry-cover / prefer-fewest-premises pass that
 *                    strips redundant derivations — core/graph.ts)
 *
 * The events ledger is GONE (2026-09-27): quiz outcomes and understanding
 * observations are no longer formalized in the graph — the graph is purely
 * extracted reasoning chains (nodes + edges).
 *
 * The extractor is a single-tool-call worker (one TypeBox-validated submit
 * call — a pi agent purely so the model can retry a schema-invalid call).
 * The auditor is a small AGENTIC loop: exploration tools plus one submit.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * (chat-handler) injects the storage ports + models; this module never
 * imports an adapter. runExtraction is single-flight per chat: a second
 * trigger while one run is in flight is a no-op (the next trigger picks up
 * whatever the in-flight run missed). On failure nothing is checkpointed —
 * the next trigger re-runs the whole thing.
 *
 * The FORMAT-AGNOSTIC FRONT DOOR (2026-09-13): importNotes() runs the SAME
 * three stages over raw personal notes (arbitrary format — no chat, no
 * session, no message ids). A notes-mode extractor prompt replaces the
 * session one; the auditor and merger are shared (identity + deterministic
 * appends don't care where text came from). Provenance is the file itself:
 * source ids ("src_" + path hash) play the chatId role in mappings and
 * checkpoints, and the source record (graphStore sources seam) carries
 * the file path + the run's usage.
 *
 * Observability (§5 baseline): every stage logs one line per step, its
 * start, and its duration; the pipeline logs a failure line before
 * rethrowing, so the server log reads start → stage timings → merged
 * stats (or failed) for every run.
 */

// ─── the source view (what the extractor sees) ──────────────────────────────

/**
 * The extraction view: the session as TEACHER PROSE ONLY (owner ruling,
 * 2026-09-28 — supersedes the 2026-09-27 whole-session markdown view),
 * each passage labeled with its actual message id (2026-10-13). The
 * shared markdown engine (core/session-markdown.ts) keeps the full session
 * format for the future user-facing export; the extractor no longer uses
 * it.
 */

/** The whole-record view (used by callers that render a full session;
 *  the pipeline itself batches). TEACHER PROSE ONLY (owner, 2026-09-28),
 *  passages labeled with their message ids (2026-10-13).
 */
export function transcriptView(record: ChatRecord): string {
	return proseView(record.messages, record.title);
}

/** The extraction view under the teacher-prose ruling (owner, 2026-09-28):
 *  ONLY learner-facing teacher prose (text or send_to_user) — no learner
 *  messages, thinking, other tool calls/results, or quiz blocks — labeled with
 *  its ACTUAL message id (owner, 2026-10-13): the view lines ARE
 *  core/coverage.ts messageViewLines ("TEACHER [id] text"), the exact
 *  lines the coverage fingerprints hash, so the extractor can anchor
 *  every proposition to the passage it came from (the session submit's
 *  required messageId). The shared markdown engine stays reserved for the
 *  future user-facing export. */
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

// The extractor redesign (owner, 2026-09-30): the extractor submits
// REASONING CHAINS — premises + conclusion — stored AS-IS (chains-primary,
// same evening: chains.jsonl is the truth; edges are a derived view, and
// supports edges are retired entirely).
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

// Weak-model tolerance (owner, 2026-09-25): the old zod `.default([])` /
// `.default({ quiz: {} })` on required-but-empty fields becomes Type.Optional
// here + a ??-fill at the submit seam (fillFindings/fillAudit below) — same
// contract on the wire (omission tolerated, empty never means "invalid"),
// no zod left in the agent band.
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

// THE SESSION EXTENSION (owner, 2026-10-13): every session proposition
// carries a REQUIRED messageId — the anchor of the passage it came from,
// copied from the view's "TEACHER [id]" label (validated at the submit
// seam against the CURRENT batch). The NOTES door has no messages: its
// schema stays the base shape above, prompt and wire unchanged.
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

/** What the extractor SUBMITS (the redesign's wire shape) — propositions
 *  + chains. fillFindings normalizes it; validateFindingsChains checks
 *  the chain laws; asSessionFindings lifts it straight into
 *  SessionFindings — chains are stored AS-IS (chains-primary, owner
 *  2026-09-30: no edge translation at any seam). */
type FindingsSubmit = Static<typeof findingsSchema>;

/** The SESSION wire — the notes shape plus the REQUIRED messageId anchor
 *  on every proposition (owner, 2026-10-13). */
type SessionFindingsSubmit = Static<typeof sessionFindingsSchema>;

// VERDICTS-ONLY (owner, 2026-09-28): the auditor never alters the
// extractor's findings, so it does not restate them — links are its
// ENTIRE deliverable (owner, 2026-09-28 evening: the edges argument is
// GONE; the auditor never mints edges. The graph connects across sources
// solely through identified equivalences — a link, never an inference).
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

// The notes front door's wire shape is the session shape MINUS the
// messageId anchor (owner, 2026-10-13: only the SESSION door demands
// passage anchors — notes have no messages, so their prompt and schema
// stay exactly as they were): one base findings type for both doors,
// the anchor riding as an optional field.
type NotesFindings = SessionFindings;
type NotesAuditResult = AuditVerdicts;

// ── the submit seam (owner, 2026-09-28; redesigned 2026-09-30) ──
//
// Every top-level field on each submit tool is REQUIRED — a payload
// missing `chains` (findings) or `links` (review) fails validation
// instead of silently merging structure-less (the degraded-retry hole:
// the model's first truncated attempt failed validation, then the retry
// passed with propositions only — optional fields ??-filled [] — merging
// a pile of nodes with no structure). Only the per-item aliases stay
// optional with a ??-fill.

export function fillFindings<T extends { propositions: Array<{ aliases?: string[] }>; chains: unknown }>(
	raw: T,
): T {
	return {
		...raw,
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	};
}

/** The notes fill: the shared alias ??-fill PLUS the door's boundary — a
 *  stray messageId (the notes schema has none; extra properties pass
 *  schema validation) is stripped so notes provenance stays chat-level
 *  (the file is the anchor, owner 2026-09-13). */
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

/** The chain laws (extractor redesign, 2026-09-30; digest-aware
 *  2026-09-30 evening) — the LOUD channel: runSubmitAgent turns a
 *  problem string into an error tool result and the model re-submits
 *  within its turns. The MIXED NAMESPACE: an
 *  endpoint resolves when it is a submitted proposition id OR an
 *  existing graph node id (the extractor continues a partly-extracted
 *  source and references digest ids verbatim). Identical (premise-set,
 *  conclusion) chains are NOT errors — they dedupe silently at the
 *  merge (chainKey): restating an argument is a no-op. */
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

/** The SESSION anchor law (owner, 2026-10-13): every proposition names a
 *  passage of the CURRENT batch — nonempty, and a teacher-prose message
 *  id present in the stretch this extractor is reading (the same ids the
 *  view's TEACHER [id] labels carry). Refused anchors ride the existing
 *  error-back channel: no merge, no coverage checkpoint, until a valid
 *  submit lands. The boundary is strict on purpose — an id from a LATER
 *  or already-covered batch, another chat, or a learner/tool message is
 *  refused even when it is a real message id of this chat. */
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

/** (chains-primary, owner 2026-09-30) the wire IS the pipeline shape
 *  now: propositions + chains, no translation — the stores keep the
 *  chains and the derived edge view is recomputed on read. The fill
 *  already ran inside runSubmitAgent; this only re-asserts the
 *  aliases-filled type (and preserves the session submit's messageId
 *  anchor, 2026-10-13 — both doors lift through here). */
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

// ── the extractor's system prompt (owner redesign, 2026-09-30) ──
//
// GOAL-FIRST, NO RULE ARMOR: the old doctrine's defensive lists (DROP
// lists, merge-your-own-output, name walls, when-in-doubt-omit, the
// faithfulness paragraph) are ALL CUT — the prompt states the goal and
// the submission mechanics; the tool's field descriptions carry the
// details. One shared core + two contextualizations, assembled here —
// session and notes share the core by construction. (The old opening
// describing Quiz/Recall-check/Question blocks was stale since the
// 2026-09-28 teacher-prose ruling and is simply omitted.)

/** The session-only anchor instruction (owner, 2026-10-13, verbatim):
 *  passages arrive labeled "TEACHER [id]" and every proposition must
 *  name the ONE passage it came from — the anchor the merger stamps
 *  into message-granular provenance. Notes have no passages: their
 *  contextualization stays untouched. */
export const SESSION_MESSAGE_ID_RULE =
	"For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";

export const SESSION_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — a teaching " +
	"session, rendered as the teacher's prose in reading order — and report what it teaches as findings " +
	"for the learner's global knowledge graph, building on everything already extracted from this source.";

export const NOTES_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — the " +
	"author's personal notes, rendered in reading order — and report what it teaches as findings for the " +
	"learner's global knowledge graph, building on everything already extracted from this source.";

export const EXTRACTION_CORE = `THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The
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

// ── the same-source digest (owner, 2026-09-30 evening) ──
//
// Serialized digest-aware extraction REPLACED the spine stage (owner
// ruling after the live test: the post-hoc assembly pass added
// complexity without perceptible gain — the extractor itself is the
// assembler when it can see what its source has already yielded). Pure
// string fold over the derived graph; "" when the source owns nothing
// yet (the first stretch runs bare). Ids ride VERBATIM — that is what
// the extractor references in its chains (the merger's mixed-namespace
// resolution passes them through).
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

/** One in-flight pipeline run. Module-level: one process, one registry.
 *  Exported for the status payload's consumer typing (the dock). */
export interface RunningExtraction {
	/** The SOURCE id (chat id / notes src id) — the payload's identity and
	 *  the abort key. The registry KEY adds "#i" for chunk jobs (a
	 *  multi-chunk source owns several entries); this field stays the
	 *  source id so the feed's reveal logic and abort stay source-scoped. */
	chatId: string;
	/** PER-CHUNK JOBS (owner, 2026-09-28): which chunk of how many this
	 *  job is — present only when the source fanned out (n > 1). Drives
	 *  the feed row's "· i/N" suffix. */
	part?: { i: number; n: number };
	/** Which front door the run came through — label + usage-persistence
	 *  depend on it (chats bill their chat record; notes bill the source
	 *  record). */
	kind: "chat" | "notes";
	/** Display label (the file path for notes imports); the status route
	 *  falls back to the chat store for chat runs. */
	label?: string;
	phase: ExtractionPhase;
	startedAt: number;
	/** Live per-stage usage, accumulated as steps bill (the dock's cost /
	 *  context-window blobs read this through /api/graph/status). */
	usage: {
		extractor?: ExtractionStageUsage;
		auditor?: ExtractionStageUsage;
	};
	/** True-cancellation handle (the dock's abort button): one controller per
	 *  run, shared across phases; abort() cancels the in-flight model call. */
	controller: AbortController;
}

interface LhExtractionGlobal {
	__lhExtractionRuns?: {
		/** In-flight pipeline runs, keyed chatId (chat) / src id (notes). */
		running: Map<string, RunningExtraction>;
		/** The single-flight guard, shared by every pipeline instance. */
		inFlight: Set<string>;
		/** Last minted startedAt — kept monotonic so two runs starting in the
		 *  same millisecond never collide on the usage idempotency key. */
		lastStartedAt: number;
	};
	/** The serialized-audit mutex (owner 2026-09-28): a FIFO promise
	 *  chain — the audit+merge critical section runs one job at a time,
	 *  process-wide. globalThis for the same module-instance reason as
	 *  the run registries. */
	__lhAuditLock?: { tail: Promise<void> };
	/** The EXTRACT SEMAPHORE (owner, 2026-09-28): 3 concurrent extractor
	 *  calls process-wide — the provider-facing rate stance (the import
	 *  route's old 3-wide pool doctrine, now global). Per-chunk jobs fan
	 *  out in parallel but queue here. */
}

/** THE RUN REGISTRIES live on globalThis, not module level — the
 *  turn-liveness lesson: Next dev compiles each route entry as its own
 *  module instance, so a module-level Map is a different object in the
 *  /api/activity route than in the pipeline's chat-handler instance —
 *  the status routes would read an always-empty registry. One process,
 *  one truth — the same idiom as the turn, wake, and abort registries
 *  (moved 2026-09-19, the observability-accuracy wave; also makes the
 *  single-flight guard cross route instances). */
function runs(): NonNullable<LhExtractionGlobal["__lhExtractionRuns"]> {
	const g = globalThis as typeof globalThis & LhExtractionGlobal;
	return (g.__lhExtractionRuns ??= { running: new Map(), inFlight: new Set(), lastStartedAt: 0 });
}

/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export function extractionStatuses(): RunningExtraction[] {
	return [...runs().running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** True cancellation of the in-flight run for a chat (the dock's abort
 *  button): the pending model call receives the signal — the provider
 *  cancels the request, spend stops — and the run ends like a failure:
 *  nothing merged, nothing checkpointed, partial usage still persisted.
 *  Returns false when no run is in flight (idempotent no-op). */
export function abortExtraction(chatId: string): boolean {
	// PER-CHUNK JOBS (owner, 2026-09-28): a source may own several registry
	// entries (one per chunk/batch) — aborting the source aborts EVERY
	// job of its fan-out.
	let found = false;
	for (const run of runs().running.values()) {
		if (run.chatId !== chatId) continue;
		run.controller.abort();
		found = true;
	}
	return found;
}
/** A notes import did not finish. Earlier graph writes and billed usage are
 * retained; partialStats describe known merges, not an all-or-nothing result. */
export class NotesImportError extends Error {
	constructor(
		public readonly outcome: "failed" | "partial" | "aborted" | "busy",
		public readonly partialStats: EmissionStats,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "NotesImportError";
	}
}
