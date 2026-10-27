"use client";

/**
 * The Keys section: the service keys the app itself still calls. Under the
 * Claude Code bridge (docs/claude-code-bridge.md) the tutor's model is the
 * learner's own Claude Code — no model-provider keys or logins live here.
 * What remains is dictation's Deepgram key.
 *
 * API: GET /api/keys (masked statuses — plaintext never leaves the server),
 * PUT /api/keys/:id {value} (shape-checked, 400 with the reason), DELETE.
 * A key set in the environment shadows the saved one; the row says so.
 */

import { useEffect, useState } from "react";
import type { AuthKeyStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsGroup, SettingsRow } from "./controls.tsx";

export function KeysSection({ initialRow }: { initialRow?: string }) {
	const [statuses, setStatuses] = useState<AuthKeyStatus[] | null>(null);
	const [editing, setEditing] = useState<string | null>(initialRow ?? null);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);

	const read = () =>
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys: AuthKeyStatus[] }) => setStatuses(body.keys.filter((k) => k.info)))
			.catch(() => setStatuses([]));

	useEffect(() => {
		void read();
	}, []);

	const save = async (id: string) => {
		setError(null);
		const res = await fetch(`/api/keys/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: draft }),
		});
		if (!res.ok) {
			setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Save failed (${res.status})`);
			return;
		}
		setDraft("");
		setEditing(null);
		await read();
		notifySettingsSaved("keys");
	};

	const remove = async (id: string) => {
		await fetch(`/api/keys/${id}`, { method: "DELETE" });
		await read();
		notifySettingsSaved("keys");
	};

	if (statuses === null) return <p className="text-xs text-muted-foreground/70">Loading keys…</p>;

	return (
		<SettingsGroup label="Service keys" testid="group-keys">
			<p className="mb-2 text-xs text-muted-foreground/70">
				The tutor is your own Claude Code (in each session&apos;s terminal) — it needs no key here.
			</p>
			{statuses.map((key) => (
				<SettingsRow
					key={key.id}
					label={key.info!.label}
					hint={
						<>
							{key.info!.description}{" "}
							<a href={key.info!.docsUrl} target="_blank" rel="noreferrer" className="underline">
								Get a key
							</a>
							{key.shadowedByEnv && " · an environment variable overrides the saved key"}
						</>
					}
					testid={`key-${key.id}`}
				>
					{editing === key.id ? (
						<span className="flex items-center gap-2">
							<input
								type="password"
								autoFocus
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void save(key.id);
									if (e.key === "Escape") {
										e.stopPropagation();
										setEditing(null);
									}
								}}
								aria-label={`${key.info!.label} key`}
								data-testid={`key-${key.id}-input`}
								className="h-8 w-56 rounded-md border border-border bg-background px-2 font-mono text-xs"
							/>
							<button type="button" className="text-xs hover:text-foreground" onClick={() => void save(key.id)}>
								Save
							</button>
						</span>
					) : (
						<span className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
							{key.present ? key.masked : "not set"}
							<button type="button" className="font-ui hover:text-foreground" onClick={() => { setError(null); setDraft(""); setEditing(key.id); }}>
								{key.present ? "Replace" : "Add"}
							</button>
							{key.present && key.source === "file" && (
								<button type="button" className="font-ui hover:text-foreground" onClick={() => void remove(key.id)}>
									Remove
								</button>
							)}
						</span>
					)}
				</SettingsRow>
			))}
			{error && (
				<p role="alert" className="text-xs text-red-500">
					{error}
				</p>
			)}
		</SettingsGroup>
	);
}
