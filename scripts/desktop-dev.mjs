// `npm run desktop:dev` on any OS: the Next dev server on 127.0.0.1:3000
// plus the Electron shell pointed at it (LH_DEV_URL). Edits to the app
// (components, routes, src/) hot-reload; edits to electron/*.cjs need this
// command restarted — never a reinstall. Ctrl+C stops both.
import { spawn } from "node:child_process";
import http from "node:http";

const URL_ = "http://localhost:3000";
const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

const next = spawn(npx, ["next", "dev", "-H", "127.0.0.1"], { stdio: "inherit", shell: isWin });
let electron;

function up() {
	return new Promise((resolve) => {
		http.get("http://127.0.0.1:3000/", (res) => { res.resume(); resolve(true); }).on("error", () => resolve(false));
	});
}

const stop = () => {
	electron?.kill();
	next.kill();
	process.exit(0);
};
process.on("SIGINT", stop);
next.on("exit", stop);

for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 1000));
electron = spawn(npx, ["electron", "."], { stdio: "inherit", shell: isWin, env: { ...process.env, LH_DEV_URL: URL_ } });
electron.on("exit", stop);
