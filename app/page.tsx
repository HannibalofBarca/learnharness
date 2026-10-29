import { Home } from "@/components/home";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the setup CTA's truth on the first frame)
export const dynamic = "force-dynamic";

export default function HomePage() {
	// First-run gate: chats cannot start until the user has picked all three slots
	const record = readSettingsRecord();
	// GRAPH RENDERING: off = the home's main view is the chains view.
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return (
		<Home initialConfigured={slotsConfigured(record?.models)} rendering={rendering} />
	);
}
