/** LearnHarness — the Electron shell. */

const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const { trustedSender } = require("./ipc-trust.cjs");
const { desktopAPIHeaders } = require("./desktop-api.cjs");
const { createTerminalHost } = require("./claude-terminal.cjs");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

// Mirrors SIDEBAR_AUTOCLOSE in components/sidebar.tsx — keep in sync (the renderer owns the number; this is the IPC widen target).
const SIDEBAR_AUTOCLOSE = 928;

const PRODUCT_NAME = "LearnHarness";

// APP NAME → userData: the Application Support dir is exactly "LearnHarness" in dev AND packaged.
app.setName(PRODUCT_NAME);
const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
const DATA_DIR = () => path.join(app.getPath("userData"), "data");

/** The packaged standalone server (extraResources → Resources/server). */
function serverEntry() {
	// extraResources ships the whole .next payload under server/standalone/ (copied from .next with an explicit filter — see electron-builder.yml).
	return path.join(process.resourcesPath, "server", "standalone", "server.js");
}

// ─── Single instance: two instances would fight over the data dir ─────────
// ─── Browser-service helper ──────── The render engines for agent jobs: PDFs and SVGs rasterize natively (pdfjs+Skia, resvg — no browser)
if (process.argv.includes("--browser-service")) {
	const { waitForBrowserService } = require("./browser-service-readiness.cjs");
	// Own the helper's entire startup lifetime, including the readiness wait.
	const lifetime = new AbortController();
	const parentClosed = () => {
		lifetime.abort(new Error("browser-service parent IPC disconnected"));
		app.quit();
	};
	(async () => {
		try {
			// Full Windows Electron replaces stdin with synthetic EOF.
			if (!process.channel || !process.connected) throw new Error("browser-service requires connected parent IPC");
			process.once("disconnect", parentClosed);
			app.dock?.hide();
			const port = await freePort();
			// Must land before app-ready for Chromium to pick it up.
			app.commandLine.appendSwitch("remote-debugging-port", String(port));
			await app.whenReady();
			// A hidden window keeps the app lifecycle ordinary on every platform (no window-all-closed handler is installed here).
			const win = new BrowserWindow({ show: false });
			await win.loadURL("about:blank");
			// Window load is not a DevTools HTTP readiness barrier.
			await waitForBrowserService(port, { signal: lifetime.signal });
			if (!lifetime.signal.aborted) console.log(`BROWSER_SERVICE_CDP ${port}`);
		} catch (err) {
			if (lifetime.signal.aborted) return; // Parent disconnect is normal.
			console.error("browser-service failed:", err);
			app.exit(1);
		}
	})();
} else {
	// Dev shell (LH_DEV_URL) runs BESIDE the packaged app, not instead of it: its own userData so (a) the single-instance lock — checked below
	if (process.env.LH_DEV_URL) {
		app.setPath("userData", `${app.getPath("userData")}-dev`);
	}

	// The whole normal boot — lock included — lives in this else
	if (!app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		app.on("second-instance", () => {
			const win = BrowserWindow.getAllWindows()[0];
			if (win) {
				if (win.isMinimized()) win.restore();
				win.focus();
			}
		});
		main();
	}
}

let serverProcess = null;
// Per-launch request capability, never OAuth tokens and never renderer state.
let desktopAPISecret = null;
let reopenWindow = null;
const trustedAppWindows = new Set();

// A GUI shell must never die to a stray exception (EPIPE dialogs, a race in an event handler): the window + child server are the product
process.on("uncaughtException", (err) => {
	try {
		log(`uncaught: ${err?.stack ?? err}`);
	} catch {
		/* nothing left to write to */
	}
});

/** A free TCP port (listen(0) → the kernel assigns one). */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** BYOK keys: auth.json in userData, flat {VAR: value} map, 0600. */

function log(line) {
	const stamp = new Date().toISOString();
	// The stdout write is guarded: a packaged app launched with a consumer-owned pipe (a launcher that exits
	try {
		console.log(`[lh ${stamp}] ${line}`);
	} catch {
		/* stdout gone — userData/logs/main.log still carries it */
	}
	// Belt and braces: also append to userData/logs so a misbehaving child can be diagnosed after the window is gone.
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

function startServer(port) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			// Only the macOS backend needs this: Next's native title setter otherwise checks this Node-mode process in as a foreground app.
			process.platform === "darwin"
				? ["--require", path.join(process.resourcesPath, "server-title-guard.cjs"), serverEntry()]
				: [serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					LH_DATA_DIR: DATA_DIR(),
					// The auth/keys store — the child reads AND writes this file itself (no env injection anymore
					LH_AUTH_FILE: AUTH_FILE(),
					LH_DESKTOP_SERVER: "1",
					LH_DESKTOP_API_SECRET: desktopAPISecret,
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		serverProcess = child;
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.on("exit", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			serverProcess = null;
		});
		resolve(child);
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function killServer() {
	if (!serverProcess) return;
	const child = serverProcess;
	serverProcess = null;
	child.kill("SIGTERM");
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 3000);
}

/** Security posture (all defaults asserted explicitly; the guards are the checklist's own recommendations for localhost-app shells) */
function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// Merged chrome: the system title bar is gone; the app's own 60px header bands ARE the title bar.
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22.5 } }
			: {
				titleBarStyle: "hidden",
				// Native min/max/close on the right, at the OS's compact default height.
				titleBarOverlay: { color: "#141414", symbolColor: "#e5e5e5" },
				// Keep the custom bar alone; Alt reveals the native menu.
				autoHideMenuBar: true,
			}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.cjs"),
		},
		// Live-resize + first-paint flash: during a resize the native window surface changes size before Chromium's compositor has a frame at the new size
		backgroundColor: "#141414",
		show: false,
		// Narrow-window behavior: 640px is the floor
		minWidth: 640,
		minHeight: 600,
	});

	trustedAppWindows.add(win);
	win.once("closed", () => trustedAppWindows.delete(win));
	const allowedOrigin = () => new URL(url).origin;
	// Deny-by-default; the ONLY grants are media (mic/STT groundwork) and clipboard-sanitized-write
	const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "local-fonts"]);
	const fromOwnOrigin = (origin, permission) =>
		origin === allowedOrigin() && allowedPermissions.has(permission);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(fromOwnOrigin(requestOrigin, permission));
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return fromOwnOrigin(origin, permission);
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});

	void win.loadURL(url);
	// Zoom truth reaches the renderer for EVERY load (reload, nav): the renderer's --lh-zoom must never go stale.
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("lh:zoom", win.webContents.getZoomFactor());
	});
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || !(input.meta || input.control)) return;
		if (input.key === "=" || input.key === "+") zoomStep(win, +1);
		else if (input.key === "-") zoomStep(win, -1);
		else if (input.key === "0") applyZoom(win, 1);
		else return;
		event.preventDefault();
	});

	win.once("ready-to-show", () => win.show());
	return win;
}

/* ── Zoom: ⌘±/⌘0 as an OWNED ladder ────────── The stock zoomIn/zoomOut roles change zoomLevel silently — the renderer never learns the factor */
const ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* ── Auto-update ───────────────────────────────── Feed: GitHub Releases (electron-builder.yml publish → app-update.yml */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let autoUpdater = null; // electron-updater's, packaged builds only
// Observational only: this snapshot NEVER gates a check, download or install.
let updateState = { status: "idle", version: null, revision: 0 };

function reportUpdateStatus(status, version = null) {
	try {
		// A later check/error must not hide an update already staged for quit.
		if (updateState.status === "downloaded" && status !== "downloaded") return;
		updateState = { status, version: typeof version === "string" ? version : null, revision: updateState.revision + 1 };
		for (const win of BrowserWindow.getAllWindows()) {
			try {
				win.webContents.send("lh:update-status", updateState);
			} catch {
				/* window mid-teardown — snapshot retrieval covers a later load */
			}
		}
	} catch {
		/* Status reporting must never interrupt the updater. */
	}
}

/** Read the SAME data directory passed to the packaged server. */
function automaticUpdatesEnabled() {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR(), "settings.json"), "utf8"));
		return settings?.general?.autoUpdate !== false;
	} catch {
		return true;
	}
}

function checkForUpdates({ manual = false } = {}) {
	if (!autoUpdater) return;
	if (!manual && !automaticUpdatesEnabled()) {
		log("auto-update: automatic check skipped (turned off in Settings)");
		return;
	}
	// Do not gate on display state: a stale spinner/error must never disable future background checks.
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			// A declined check (e.g. an unsupported package) establishes no latest-version claim.
			if (!result) reportUpdateStatus("idle");
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			reportUpdateStatus("error");
		});
}

function installUpdateNow() {
	// Kill the server BEFORE the quit-and-install (see block comment).
	try {
		killServer();
	} catch {
		/* already dead */
	}
	autoUpdater?.quitAndInstall();
}

function setupAutoUpdater() {
	// ClaudeHarness fork (docs/claude-code-bridge.md): updates are OFF for good.
	if (process.env.LH_UPDATE_FEED === undefined) {
		log("auto-update: disabled in this fork");
		reportUpdateStatus("disabled");
		return;
	}
	if (!app.isPackaged) {
		log("auto-update: dev build — updater disabled");
		reportUpdateStatus("disabled");
		return;
	}
	try {
		autoUpdater = require("electron-updater").autoUpdater;
	} catch (err) {
		log(`auto-update: electron-updater unavailable (${err?.message ?? err}) — updates disabled`);
		reportUpdateStatus("disabled");
		return;
	}
	const feed = process.env.LH_UPDATE_FEED;
	if (feed) {
		autoUpdater.setFeedURL({ provider: "generic", url: feed });
		log(`auto-update: LH_UPDATE_FEED override → ${feed}`);
	}
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	// Route every updater log line through the shell's own log (userData/ logs/main.log) — feed failures must be diagnosable after the fact.
	autoUpdater.logger = {
		info: (m) => log(`updater: ${m}`),
		warn: (m) => log(`updater warn: ${m}`),
		debug: (m) => {}, // too chatty for the persistent log
		error: (m) => log(`updater error: ${m}`),
	};
	autoUpdater.on("checking-for-update", () => reportUpdateStatus("checking"));
	autoUpdater.on("update-available", (info) => reportUpdateStatus("downloading", info?.version));
	autoUpdater.on("update-not-available", () => reportUpdateStatus("up-to-date"));
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} — banner shown`);
		reportUpdateStatus("downloaded", info?.version);
	});
	autoUpdater.on("error", (err) => {
		log(`updater error: ${err?.message ?? err}`);
		reportUpdateStatus("error");
	});
}

/** One result surface for manual checks. */
function checkForUpdatesFromMenu() {
	try {
		const win = BrowserWindow.getAllWindows()[0] ?? reopenWindow?.();
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
			const openSettings = () => {
				try { win.webContents.send("lh:open-settings", "general"); } catch { /* window closed */ }
			};
			if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", openSettings);
			else openSettings();
		}
	} catch {
		/* Navigation failure must not prevent the manual check. */
	}
	checkForUpdates({ manual: true });
}

function zoomStep(win, dir) {
	const current = win.webContents.getZoomFactor();
	const next =
		dir > 0
			? ZOOM_LADDER.find((f) => f > current + 0.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1]
			: [...ZOOM_LADDER].reverse().find((f) => f < current - 0.001) ?? ZOOM_LADDER[0];
	applyZoom(win, next);
}

function applyZoom(win, factor) {
	factor = Math.min(2, Math.max(0.75, factor)); // ladder clamps; ⌘0 = 1
	win.webContents.setZoomFactor(factor);
	win.webContents.send("lh:zoom", factor);
}

/** macOS needs an application menu with the Edit roles — without one, Cmd+C/V/A do nothing in the renderer. */
function installMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				// Manual checks report their result in Settings → General.
				{ label: "Check for Updates…", click: () => checkForUpdatesFromMenu() },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				// OWNED zoom (see applyZoom): the roles change zoomLevel silently; these broadcast the factor and re-seat the traffic lights.
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => applyZoom(BrowserWindow.getAllWindows()[0], 1),
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], +1),
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], -1),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
	app.on("window-all-closed", () => {
		// macOS convention: the app stays resident, reactivated from the Dock.
		if (process.platform !== "darwin") app.quit();
	});

	// The child must not outlive us — cover every quit path.
	app.on("before-quit", killServer);
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);

	await app.whenReady();

	// Dev mode: point at a running `next dev` server (LH_DEV_URL) — no spawn, no packaging, full HMR.
	const devUrl = process.env.LH_DEV_URL;
	const url = devUrl ?? `http://127.0.0.1:${await freePort()}`;
	if (!devUrl) {
		desktopAPISecret = randomBytes(32).toString("hex");
		const ownedOrigin = new URL(url).origin;
		// All URLs, not only /api: remove the header again on external redirects.
		session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
			callback({ requestHeaders: desktopAPIHeaders(details, ownedOrigin, desktopAPISecret, [...trustedAppWindows]) });
		});
		log(`starting server: ${serverEntry()}`);
		log(`data dir: ${DATA_DIR()}`);
		await startServer(new URL(url).port);
		await waitUntilUp(url);
		log(`server up: ${url}`);
	} else {
		log(`dev mode: ${devUrl}`);
	}

	// The embedded tutor terminal (docs/claude-code-bridge.md): one pty per session, launched with the server's pre-wired Claude Code argv.
	const trusted = (event) => trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) && trustedSender(event, new URL(url).origin, BrowserWindow);
	const terminals = createTerminalHost({
		serverUrl: () => new URL(url).origin,
		secret: () => desktopAPISecret,
		onData: (chatId, data) => { for (const win of trustedAppWindows) if (!win.isDestroyed()) win.webContents.send("lh:terminal:data", chatId, data); },
		onExit: (chatId, code) => { for (const win of trustedAppWindows) if (!win.isDestroyed()) win.webContents.send("lh:terminal:exit", chatId, code); },
		log,
	});
	app.on("before-quit", () => terminals.killAll());
	ipcMain.handle("lh:terminal:open", async (event, chatId, cols, rows) => {
		if (!trusted(event)) throw new Error("Untrusted desktop request.");
		return terminals.open(String(chatId), Number(cols) || 80, Number(rows) || 24);
	});
	ipcMain.on("lh:terminal:input", (event, chatId, data) => { if (trusted(event)) terminals.write(String(chatId), data); });
	ipcMain.on("lh:terminal:resize", (event, chatId, cols, rows) => { if (trusted(event)) terminals.resize(String(chatId), Number(cols), Number(rows)); });
	ipcMain.on("lh:terminal:kill", (event, chatId) => { if (trusted(event)) terminals.kill(String(chatId)); });

	installMenu();

	// Auto-update: wire the updater before the window so the banner channel is live from first paint
	setupAutoUpdater();
	ipcMain.on("lh:update-install", () => installUpdateNow());
	ipcMain.handle("lh:update:get", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		return updateState;
	});
	ipcMain.handle("lh:update:check", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		checkForUpdates({ manual: true });
	});

	// Sidebar-at-narrow-window: the renderer auto-closes the sidebar below SIDEBAR_AUTOCLOSE (928px)
	ipcMain.handle("lh:zoom:get", (event) => BrowserWindow.fromWebContents(event.sender)?.webContents.getZoomFactor() ?? 1);
	ipcMain.on("lh:expand-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const { x, y, width, height } = win.getBounds();
		const target = SIDEBAR_AUTOCLOSE;
		if (width < target) win.setBounds({ x, y, width: target, height });
	});
	reopenWindow = () => createWindow(url);
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) reopenWindow();
	});
	createWindow(url);
	log(`window open: ${url}`);
	// Startup + 24h checks stay main-owned and read the current preference.
	if (autoUpdater) {
		checkForUpdates();
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}