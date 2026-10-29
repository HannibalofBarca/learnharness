"use strict";

/** An IPC request is trusted only from a window's main frame on the app's own origin (never a subframe, never a navigated-away page). */
function trustedSender(event, origin, BrowserWindow) {
	const win = BrowserWindow.fromWebContents(event.sender);
	try {
		return !!win && event.senderFrame === event.sender.mainFrame && new URL(event.senderFrame.url).origin === origin;
	} catch { return false; }
}

module.exports = { trustedSender };
