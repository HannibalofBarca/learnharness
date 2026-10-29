"use client";

/** THE TOP BAR: one element, every surface — the same mechanics ALWAYS. */

import type { ReactNode } from "react";
import { SidebarToggle } from "@/components/sidebar";

export function TopBar({
	drag = true,
	onMouseDown,
	children,
}: {
	drag?: boolean;
	onMouseDown?: React.MouseEventHandler<HTMLElement>;
	children?: ReactNode;
}) {
	return (
		<header
			onMouseDown={onMouseDown}
			className={`${drag ? "lh-drag " : ""}lh-wco-gutter flex h-15 select-none items-center gap-3 border-b border-border px-3`}
		>
			<SidebarToggle />
			{children}
		</header>
	);
}
