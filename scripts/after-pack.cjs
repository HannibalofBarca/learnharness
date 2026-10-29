// electron-builder afterPack hook — mac only.
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const appBundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const target = path.join(appBundle, "Contents", "Resources", "icon.icns");
	const source = path.join(context.packager.info.projectDir, "build", "icon.icns");
	fs.copyFileSync(source, target);
	console.log(`[after-pack] pre-Tahoe fallback icns (full-res) → ${target}`);
};
