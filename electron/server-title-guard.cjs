/** Preloaded only into the packaged macOS backend, before Next starts. */
if (process.platform === "darwin" && process.env.ELECTRON_RUN_AS_NODE === "1" && process.env.LH_DESKTOP_SERVER === "1") {
	let title = process.title;
	Object.defineProperty(process, "title", {
		configurable: true,
		enumerable: true,
		get: () => title,
		set: (value) => {
			title = String(value);
		},
	});
}
