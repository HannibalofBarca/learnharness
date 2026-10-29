"use client";

/** THE cross-surface settings signal: every WRITER dispatches after a successful PUT, every READER re-reads */
import { useEffect, useRef } from "react";

const SETTINGS_SAVED_EVENT = "lh:settings-saved";

/** The settings sections a writer can land (the write seam's union). */
// "keys" joined the roster: keys-section dispatches it after save AND delete
type SettingsSection = "general" | "keys" | "agent" | "models" | "appearance" | "graph" | "compaction";

/** Writers call this after the PUT resolves ok — never before (a failed write notifies nothing; the record is unchanged). */
export function notifySettingsSaved(section: SettingsSection): void {
	window.dispatchEvent(
		new CustomEvent(SETTINGS_SAVED_EVENT, { detail: { section } }),
	);
}

/** Non-hook listener (imperative seams, tests). Returns an unsubscribe. */
function onSettingsSaved(handler: (section: SettingsSection) => void): () => void {
	const listener = (e: Event) => {
		const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
		if (section !== undefined) handler(section);
	};
	window.addEventListener(SETTINGS_SAVED_EVENT, listener);
	return () => window.removeEventListener(SETTINGS_SAVED_EVENT, listener);
}

/** Reader subscription: re-invokes whenever a writer lands */
export function useSettingsSaved(handler: (section: SettingsSection) => void): void {
	const saved = useRef(handler);
	saved.current = handler;
	useEffect(() => onSettingsSaved((section) => saved.current(section)), []);
}