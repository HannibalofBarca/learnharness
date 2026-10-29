/* Preload: the ONLY bridge between the sandboxed renderer and the main process. */
const { contextBridge, ipcRenderer } = require("electron");

let openSettingsListener = null;
let pendingOpenSettings = null;
ipcRenderer.on("lh:open-settings", (_event, section) => {
	if (openSettingsListener) openSettingsListener(section);
	else pendingOpenSettings = section;
});

contextBridge.exposeInMainWorld("lh", {
	platform: process.platform,
	// The embedded tutor terminal (docs/claude-code-bridge.md): keystrokes and sizes for one session id; main decides what runs.
	terminal: {
		open: (chatId, cols, rows) => ipcRenderer.invoke("lh:terminal:open", chatId, cols, rows),
		input: (chatId, data) => ipcRenderer.send("lh:terminal:input", chatId, data),
		resize: (chatId, cols, rows) => ipcRenderer.send("lh:terminal:resize", chatId, cols, rows),
		kill: (chatId) => ipcRenderer.send("lh:terminal:kill", chatId),
		onData: (cb) => {
			const listener = (_event, chatId, data) => cb(chatId, data);
			ipcRenderer.on("lh:terminal:data", listener);
			return () => ipcRenderer.removeListener("lh:terminal:data", listener);
		},
		onExit: (cb) => {
			const listener = (_event, chatId, code) => cb(chatId, code);
			ipcRenderer.on("lh:terminal:exit", listener);
			return () => ipcRenderer.removeListener("lh:terminal:exit", listener);
		},
	},
	expandWindow: () => ipcRenderer.send("lh:expand-window"),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("lh:zoom", listener);
		return () => ipcRenderer.removeListener("lh:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("lh:zoom:get"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("lh:update-status", listener);
		return () => ipcRenderer.removeListener("lh:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("lh:update-install"),
	getUpdateState: () => ipcRenderer.invoke("lh:update:get"),
	checkForUpdates: () => ipcRenderer.invoke("lh:update:check"),
	onOpenSettings: (cb) => {
		openSettingsListener = cb;
		if (pendingOpenSettings !== null) {
			const section = pendingOpenSettings;
			pendingOpenSettings = null;
			cb(section);
		}
		return () => {
			if (openSettingsListener === cb) openSettingsListener = null;
		};
	},
});
