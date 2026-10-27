"use client";

/**
 * The embedded tutor terminal (docs/claude-code-bridge.md): the session's
 * Claude Code, running in a pty owned by the desktop shell. The learner
 * reads and answers in the session above; this pane shows Claude working
 * and accepts direct input. Desktop only — the browser build has no pty and
 * shows how to connect instead.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalBridge {
	open: (chatId: string, cols: number, rows: number) => Promise<string>;
	input: (chatId: string, data: string) => void;
	resize: (chatId: string, cols: number, rows: number) => void;
	kill: (chatId: string) => void;
	onData: (cb: (chatId: string, data: string) => void) => () => void;
	onExit: (cb: (chatId: string, code: number) => void) => () => void;
}

function bridge(): TerminalBridge | undefined {
	return (window.lh as { terminal?: TerminalBridge } | undefined)?.terminal;
}

const HEIGHT_KEY = "lh:terminal-height";
const OPEN_KEY = "lh:terminal-open";

function readNumber(key: string, fallback: number): number {
	try {
		const v = Number(localStorage.getItem(key));
		return Number.isFinite(v) && v > 0 ? v : fallback;
	} catch {
		return fallback;
	}
}

export function ClaudeTerminal({ chatId }: { chatId: string }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [available, setAvailable] = useState<boolean | null>(null);
	const [open, setOpen] = useState(true);
	const [height, setHeight] = useState(240);
	const [exited, setExited] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [generation, setGeneration] = useState(0);

	useEffect(() => {
		setAvailable(Boolean(bridge()));
		setHeight(readNumber(HEIGHT_KEY, 240));
		try {
			setOpen(localStorage.getItem(OPEN_KEY) !== "0");
		} catch {
			/* storage blocked: stay open */
		}
	}, []);

	useEffect(() => {
		const term = bridge();
		const host = hostRef.current;
		if (!term || !host || !open) return;
		setExited(null);
		setError(null);
		const xterm = new Terminal({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 12,
			cursorBlink: true,
			convertEol: false,
			theme: { background: "#0b0b0c", foreground: "#e6e6e6" },
		});
		const fit = new FitAddon();
		xterm.loadAddon(fit);
		xterm.open(host);
		fit.fit();
		let disposed = false;
		const offData = term.onData((id, data) => {
			if (id === chatId) xterm.write(data);
		});
		const offExit = term.onExit((id, code) => {
			if (id === chatId) setExited(code);
		});
		const typing = xterm.onData((data) => term.input(chatId, data));
		void term
			.open(chatId, xterm.cols, xterm.rows)
			.then((scrollback) => {
				if (!disposed && scrollback) xterm.write(scrollback);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		const observer = new ResizeObserver(() => {
			fit.fit();
			term.resize(chatId, xterm.cols, xterm.rows);
		});
		observer.observe(host);
		return () => {
			disposed = true;
			observer.disconnect();
			typing.dispose();
			offData();
			offExit();
			xterm.dispose();
		};
	}, [chatId, open, generation]);

	const toggle = () => {
		setOpen((v) => {
			try {
				localStorage.setItem(OPEN_KEY, v ? "0" : "1");
			} catch {
				/* per-viewer convenience only */
			}
			return !v;
		});
	};

	const startDrag = (e: React.PointerEvent) => {
		const startY = e.clientY;
		const startH = height;
		const move = (ev: PointerEvent) => setHeight(Math.min(Math.max(startH + (startY - ev.clientY), 120), 640));
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			setHeight((h) => {
				try {
					localStorage.setItem(HEIGHT_KEY, String(h));
				} catch {
					/* per-viewer convenience only */
				}
				return h;
			});
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	if (available === null) return null;

	return (
		<div data-testid="claude-terminal" className="shrink-0 border-t border-border bg-[#0b0b0c]">
			{open && <div onPointerDown={startDrag} className="h-1 cursor-row-resize bg-border/40 hover:bg-border" aria-hidden />}
			<div className="flex h-7 items-center gap-2 px-3 font-ui text-xs text-neutral-400">
				<button type="button" onClick={toggle} className="hover:text-neutral-100">
					{open ? "▾" : "▸"} Claude Code
				</button>
				{exited !== null && <span>· exited ({exited}) — shell still open</span>}
				{error && <span className="text-amber-400">· {error}</span>}
				{available && open && (
					<button
						type="button"
						className="ml-auto hover:text-neutral-100"
						onClick={() => {
							bridge()?.kill(chatId);
							setGeneration((g) => g + 1);
						}}
					>
						Restart
					</button>
				)}
			</div>
			{open &&
				(available ? (
					<div ref={hostRef} style={{ height }} className="px-2 pb-2" />
				) : (
					<p className="px-3 pb-3 font-ui text-xs text-neutral-400">
						The tutor terminal runs in the LearnHarness desktop app. In the browser, start Claude Code yourself with the launch from{" "}
						<code>/api/claude/launch?chat={chatId}</code>.
					</p>
				))}
		</div>
	);
}
