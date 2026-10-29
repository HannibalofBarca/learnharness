/** THE UNIVERSAL ARGUMENT HEAL — the agent-boundary wiring. */

import type { AgentTool } from "../../core/agent-types.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";

export { healEncodedArguments };

/** Wrap ONE tool with the standard heal: the tool's own prepareArguments (options-unwrap, target normalization, …) runs first */
export function withArgumentHeal(tool: AgentTool<any>): AgentTool<any> {
	const inner = tool.prepareArguments;
	return {
		...tool,
		prepareArguments: (args: unknown) => healEncodedArguments(inner ? inner(args) : args, tool.parameters),
	};
}

/** The registry-wide form: wrap every tool in a tool record. */
export function healToolRecord(tools: Record<string, AgentTool<any>>): Record<string, AgentTool<any>> {
	return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, withArgumentHeal(tool)]));
}
