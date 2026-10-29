/** The pure prompt-segment grammar: segment-path validation + the shared segment types, ZERO fs. */

/** A prompt fragment: numeric order key + .md (e.g. 20-teaching.md). Nothing else loads. */
export const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

/** Which agent's prompt directory to compose. */
/** Practice: composes ONLY its own directory — no shared teaching base, no shared fragments (the doctrine contradicts the teaching philosophy */
export type PromptAgent = "prober" | "teacher" | "practice";

/** One segment of one agent's composed prompt. */
export interface PromptSegmentInfo {
	/** The override/store key — mirrors the source layout ("system-prompt.md", "shared/05-learner-files.md", "teacher/20-teaching.md"). */
	path: string;
	/** The source text (what the segment runs without an override). */
	sourceText: string;
	/** The user's override text, or null when no file exists on disk. */
	overrideText: string | null;
	/** Effective state: the settings switch AND the file both present. */
	enabled: boolean;
	/** True for segments BOTH agents compose — the base and shared/ fragments. */
	shared: boolean;
}

/** Validate a segment path against the mirror-layout rules (see module doc). */
export function isValidSegmentPath(segmentPath: string): boolean {
	if (segmentPath === "system-prompt.md") return true;
	const m = /^(prober|teacher|practice|shared)\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[2] === undefined) return false;
	return FRAGMENT_RE.test(m[2]);
}
