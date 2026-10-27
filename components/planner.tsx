"use client";

/**
 * The Planner page (ClaudeHarness): the learner's plans, and the planner's
 * Claude Code terminal underneath — their own unrestricted Claude Code with
 * the LearnHarness planning tools (src/server/claude/planner.ts). Plans are
 * re-read every few seconds so what the planner saves appears on its own.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageResponse } from "@/components/ai-elements/message";
import { ClaudeTerminal } from "@/components/claude-terminal";

interface PlanTopic {
	title: string;
	goal: string;
	sessionId?: string;
}
interface Plan {
	id: string;
	title: string;
	markdown: string;
	topics: PlanTopic[];
	updatedAt: string;
}

const POLL_MS = 3000;

export function Planner() {
	const router = useRouter();
	const [plans, setPlans] = useState<Plan[] | null>(null);
	const [open, setOpen] = useState<string | null>(null);

	const read = useCallback(() => {
		fetch("/api/plans")
			.then((r) => r.json() as Promise<{ plans: Plan[] }>)
			.then((body) => setPlans(body.plans))
			.catch(() => {});
	}, []);

	useEffect(() => {
		read();
		const timer = setInterval(read, POLL_MS);
		return () => clearInterval(timer);
	}, [read]);

	const startTopic = async (planId: string, index: number) => {
		const res = await fetch(`/api/plans/${planId}/topics/${index}`, { method: "POST" });
		const body = (await res.json().catch(() => ({}))) as { chatId?: string };
		if (body.chatId) router.push(`/chat/${body.chatId}`);
	};

	const remove = async (planId: string) => {
		await fetch(`/api/plans/${planId}`, { method: "DELETE" });
		read();
	};

	return (
		<div className="flex h-dvh flex-col" data-testid="planner">
			<div className="lh-drag flex h-15 shrink-0 items-center border-b border-border px-6">
				<h1 className="font-ui text-sm font-medium">Planner</h1>
				<span className="ml-3 text-xs text-muted-foreground">Plan with Claude below — it reads your docs, writes plans, and opens sessions.</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
				{plans === null ? (
					<p className="text-xs text-muted-foreground">Loading plans…</p>
				) : plans.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No plans yet. Tell Claude in the terminal what you want to learn and where your docs are.
					</p>
				) : (
					<div className="mx-auto flex max-w-3xl flex-col gap-4">
						{plans.map((plan) => (
							<section key={plan.id} className="rounded-xl border border-border bg-card p-4" data-testid={`plan-${plan.id}`}>
								<div className="flex items-center gap-3">
									<h2 className="font-ui text-base font-medium">{plan.title}</h2>
									<span className="text-xs text-muted-foreground">{new Date(plan.updatedAt).toLocaleString()}</span>
									<button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(open === plan.id ? null : plan.id)}>
										{open === plan.id ? "Hide plan" : "Show plan"}
									</button>
									<button type="button" className="text-xs text-muted-foreground hover:text-red-400" onClick={() => void remove(plan.id)}>
										Delete
									</button>
								</div>
								{open === plan.id && (
									<div className="lh-prose mt-3 text-sm">
										<MessageResponse>{plan.markdown}</MessageResponse>
									</div>
								)}
								<ol className="mt-3 flex flex-col gap-1.5">
									{plan.topics.map((topic, i) => (
										<li key={`${plan.id}-${i}`} className="flex items-start gap-3 text-sm">
											<span className="w-5 shrink-0 text-right text-muted-foreground">{i + 1}.</span>
											<span className="min-w-0 flex-1">
												<span className="font-medium">{topic.title}</span>
												<span className="block text-xs text-muted-foreground">{topic.goal}</span>
											</span>
											<button
												type="button"
												className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
												onClick={() => void startTopic(plan.id, i)}
											>
												{topic.sessionId ? "Open" : "Start"}
											</button>
										</li>
									))}
								</ol>
							</section>
						))}
					</div>
				)}
			</div>
			<ClaudeTerminal chatId="planner" />
		</div>
	);
}
