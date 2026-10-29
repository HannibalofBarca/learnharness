/** POST-less BYOK mint: the renderer never holds the real Deepgram key. */
import { keyValue } from "@/src/server";

export async function GET() {
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) {
		return Response.json(
			{ message: "No DEEPGRAM_API_KEY — add it to auth.json (desktop) or .env.local (dev)." },
			{ status: 503 },
		);
	}

	try {
		const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
		});
		if (!res.ok) {
			const detail = await res.text();
			return Response.json(
				{ message: `Deepgram token grant failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) {
			return Response.json({ message: "Deepgram grant returned no token" }, { status: 502 });
		}
		return Response.json({ token: data.access_token });
	} catch {
		return Response.json({ message: "Deepgram unreachable" }, { status: 502 });
	}
}
