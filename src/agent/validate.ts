/** Tool-argument validation (the old engine loop's job, now the bridge's — docs/claude-code-bridge.md): the tool's argument heal first */

import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { AgentTool } from "../core/agent-types.ts";

const validators = new WeakMap<object, ReturnType<typeof Compile>>();

export function validateArguments(tool: AgentTool<any>, raw: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
	const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
	const args = structuredClone(prepared ?? {});
	Value.Convert(tool.parameters, args);
	let validator = validators.get(tool.parameters);
	if (!validator) {
		validator = Compile(tool.parameters);
		validators.set(tool.parameters, validator);
	}
	if (validator.Check(args)) return { ok: true, args };
	const problems = validator
		.Errors(args)
		.map((e) => `  - ${e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root"}: ${e.message}`)
		.join("\n");
	return { ok: false, error: `Validation failed for tool "${tool.name}":\n${problems || "  - unknown error"}` };
}

/** The engine-era call shape: validated args, or a thrown validation error. */
export function validateToolArguments(tool: AgentTool<any>, call: { arguments: unknown; [key: string]: unknown }): any {
	const result = validateArguments(tool, call.arguments);
	if (!result.ok) throw new Error(result.error);
	return result.args;
}
