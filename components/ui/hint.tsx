"use client"

import * as React from "react"
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { bindingForAction, formatBinding, type KeyAction } from "@/src/core"

/** The tooltip composition for icon and pill controls. */

interface HintProps {
	label: string
	/** Registry action whose LIVE binding is shown (override-aware). */
	action?: KeyAction
	/** Surface-owned binding ("escape", "enter") — keys the registry deliberately doesn't dispatch (Esc closes the dialog itself */
	binding?: string
	side?: "top" | "bottom" | "left" | "right"
	children: React.ReactElement
}

/** The composition itself, pure — "Dictate" + ⌘D → "Dictate (⌘D)". */
function hintText(label: string, action?: KeyAction, binding?: string): string {
	const live = action
		? formatBinding(bindingForAction(action))
		: binding
			? formatBinding(binding)
			: ""
	return live ? `${label} (${live})` : label
}

export function Hint({ label, action, binding, side = "top", children }: HintProps) {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{children}</TooltipTrigger>
				<TooltipContent side={side}>{hintText(label, action, binding)}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}