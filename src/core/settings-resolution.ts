/** THE SETTINGS RESOLUTION LAYER: pure projection of the delta record (core/settings.ts UserSettings) into EffectiveSettings — every field CONCRETE */

import type { ThinkingLevel } from "./agent-types.ts";
import type { ModelRole } from "../../config.ts";
import type { SearchEngineId } from "./search.ts";
import {
	BACKGROUND_MODEL_ROLES,
	FACTORY_SETTINGS,
	ROLE_SLOT,
	type BackgroundModelRole,
	type FactorySettings,
	type GeneralSettings,
	type CompactionSettings,
	type GraphSettings,
	type ModelSlot,
	type ModelSlotName,
	type RoleModelOverride,
	type UserSettings,
} from "./settings.ts";

/** A configured model slot: the tier's concrete model, with its optional thinking level. */
export interface EffectiveSlot {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** A fully-resolved model pin for one role — same shape/level semantics as EffectiveSlot */
export interface EffectiveModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The concrete appearance view — same shape as the factory's. */
export type EffectiveAppearance = FactorySettings["appearance"];

/** The concrete view: every knob resolved, no absent fields. */
export interface EffectiveSettings {
	general: Required<GeneralSettings>;
	agent: {
		models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
		/** Delta map as stored — consumers resolve absent key → enabled. */
		tools: Record<string, boolean>;
		/** Delta map as stored — absent key → override off. */
		prompts: Record<string, boolean>;
		/** The search-engine preference as stored: passthrough delta — engine resolution (pin → auto → unavailable) lives in server/search.ts */
		search: { engine?: SearchEngineId };
		/** Prober graph tools: passthrough delta as stored — absent/undefined enabled = ON; consumers use graphToolsEnabled. */
		graphTools: { enabled?: boolean };
	};
	/** The resolved strong/cheap/vision slots: each tier's concrete model or NULL when the tier holds no model. */
	models: Record<ModelSlotName, EffectiveSlot | null>;
	appearance: EffectiveAppearance;
	graph: Required<GraphSettings>;
	/** Compaction: resolved concrete — absent record section resolves to the factory 150k. */
	compaction: Required<CompactionSettings>;
}



/** Resolve one slot to its configured view, or null when the tier holds no model (a thinkingLevel-only slot is inert */
function resolveSlot(slot: ModelSlot | undefined): EffectiveSlot | null {
	if (!slot?.model) return null;
	return { provider: slot.model.provider, id: slot.model.id, thinkingLevel: slot.thinkingLevel };
}

/** Resolve one role's spec — the BYOK chain: role override → SLOT → NOTHING, each field independent (an override may borrow only the slot's model */
function resolveModelSpec(
	role: ModelRole,
	override: RoleModelOverride | undefined,
	slots?: Partial<Record<ModelSlotName, ModelSlot>>,
): EffectiveModelSpec | undefined {
	const slotName = ROLE_SLOT[role] as ModelSlotName | undefined;
	const slot = slotName ? slots?.[slotName] : undefined;
	const model = override?.model ?? slot?.model;
	if (!model) return undefined;
	return {
		provider: model.provider,
		id: model.id,
		thinkingLevel: override?.thinkingLevel ?? slot?.thinkingLevel,
	};
}

/** Resolve the whole record. */
export function resolveSettings(record: UserSettings | null): EffectiveSettings {
	const agent = record?.agent ?? {};
	const modelsSection = record?.models ?? {};
	const appearance = record?.appearance ?? {};
	const md = appearance.mdRendering ?? {};
	const graph = record?.graph ?? {};
	const factoryAppearance = FACTORY_SETTINGS.appearance;
	const factoryMd = factoryAppearance.mdRendering;
	const models = {} as Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
	for (const role of BACKGROUND_MODEL_ROLES) {
		models[role] = resolveModelSpec(role, agent.models?.[role], modelsSection);
	}
	return {
		general: {
			autoUpdate: record?.general?.autoUpdate ?? FACTORY_SETTINGS.general.autoUpdate,
		},
		agent: {
			models,
			tools: agent.tools ?? {},
			prompts: agent.prompts ?? {},
			search: agent.search ?? {},
			graphTools: agent.graphTools ?? {},
		},
		models: {
			strong: resolveSlot(modelsSection.strong),
			cheap: resolveSlot(modelsSection.cheap),
			vision: resolveSlot(modelsSection.vision),
		},
		appearance: {
			mode: appearance.mode ?? factoryAppearance.mode,
			background: appearance.background ?? factoryAppearance.background,
			fontFamily: appearance.fontFamily ?? factoryAppearance.fontFamily,
			proseFontSize: appearance.proseFontSize ?? factoryAppearance.proseFontSize,
			sessionNameSerif: appearance.sessionNameSerif ?? factoryAppearance.sessionNameSerif,
			mdRendering: {
				headingWeight: md.headingWeight ?? factoryMd.headingWeight,
				boldColor: md.boldColor ?? factoryMd.boldColor,
				italicColor: md.italicColor ?? factoryMd.italicColor,
			},
		},
		graph: {
			// Wave 7 collapse: the master switch ONLY — the embedding/clustering/labeling rungs and the BYOK embeddingModel are gone (stale record keys are simply
			enabled: graph.enabled ?? FACTORY_SETTINGS.graph.enabled,
			// The RENDERING switch: display-only — gates the home's main view (canvas vs chains), never the data.
			rendering: graph.rendering ?? FACTORY_SETTINGS.graph.rendering,
			// The chunk budget: absent (pre-redesign record, fresh install) resolves to the factory 4096
			extractionChunkTokens: graph.extractionChunkTokens ?? FACTORY_SETTINGS.graph.extractionChunkTokens,
		},
		compaction: {
			thresholdTokens: record?.compaction?.thresholdTokens ?? FACTORY_SETTINGS.compaction.thresholdTokens,
		},
	};
}

// ─── Graph channel gates ─────────────────

/** The WRITE channel gate (extraction + its auditor): dies with the master switch. */
export function extractionEnabled(graph: { enabled: boolean }): boolean {
	return graph.enabled;
}

/** The RENDERING gate: graph off = the home shows the chains view, not the canvas. */
export function renderingEnabled(graph: { rendering: boolean }): boolean {
	return graph.rendering;
}

/** The PROBER GRAPH TOOLS gate: the toggle is an agent-capability switch (it gates tool registration) */
export function graphToolsEnabled(effective: {
	graph: { enabled: boolean };
	agent: { graphTools: { enabled?: boolean } };
}): boolean {
	return effective.graph.enabled && (effective.agent.graphTools.enabled ?? true);
}


