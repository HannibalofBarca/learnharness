/** The dock shell's variant key (the WAAPI height-morph trigger, components/chat.tsx DockOverlay). */
export function dockStateKey(mode: string, docked: boolean, expanded: boolean): string {
	return docked ? `${mode}:${expanded}` : `${mode}:-`;
}
