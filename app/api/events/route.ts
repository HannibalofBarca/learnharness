/** THE NOTIFICATION CHANNEL ROUTE: one SSE connection per open window over the core event bus — the endpoint every future consumer (chat view, sidebar */
import { eventsResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return eventsResponse();
}
