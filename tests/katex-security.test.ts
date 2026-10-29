/** GHSA-238p-pmpm-9mq7: inherited properties must not become KaTeX authority. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import katex from "katex";
import { MessageResponse } from "../components/ai-elements/message.tsx";

(globalThis as Record<string, unknown>).React = React;
const blocked = String.raw`\href{https://katex-security.invalid/blocked}{blocked}`;
function withoutAuthority(html: string) {
	const { document } = parseHTML(html);
	assert.equal(document.querySelectorAll("[href], [src], a, img, script, iframe").length, 0, "inherited authority must not emit active HTML or URL attributes");
	assert.ok(html.includes("blocked"), "the formula was actually processed");
}
function withPrototype(key: string, value: unknown, run: () => void) {
	const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
	try {
		Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
		run();
	} finally {
		if (previous) Object.defineProperty(Object.prototype, key, previous);
		else Reflect.deleteProperty(Object.prototype, key);
	}
}
function markdown() {
	return renderToStaticMarkup(React.createElement(MessageResponse, { mode: "static" }, `$${blocked}$`));
}

describe("KaTeX prototype read-side security", { concurrency: false }, () => {
	it("ignores Object.prototype.trust in direct and app markdown rendering", () => {
		withPrototype("trust", true, () => {
			withoutAuthority(katex.renderToString(blocked, { strict: false }));
			withoutAuthority(markdown());
		});
	});
	it("ignores trust inherited from a custom options prototype", () => {
		const options = Object.assign(Object.create({ trust: true }), { strict: false });
		withoutAuthority(katex.renderToString(blocked, options));
	});
});
