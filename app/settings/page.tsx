import { redirect } from "next/navigation";

/** The settings surface graduated into a centered dialog over the app. */
export default function SettingsPage() {
	redirect("/chat/new");
}
