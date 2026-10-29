/**
 * Render tests for the presentation layer (W3): the \(...\)/\[...\] math
 * delimiter contract, single-newline line breaks, and mermaid rendering.
 *
 * Same idiom as render-cards.test.tsx: static HTML via react-dom/server, no
 * DOM. tsx note: tsx uses the CLASSIC JSX transform, so `React` must be a
 * resolvable global — the shim below provides it.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transformMathDelimiters } from "../src/core/math-delims.ts";


describe("math delimiter transform (pure unit)", () => {
	it("converts inline \\(...\\) to the two-dollar inline form", () => {
		assert.equal(
			transformMathDelimiters("a \\(x^2\\) b"),
			"a $$x^2$$ b",
		);
	});

	it("converts block-positioned \\[...\\] to flow math in place", () => {
		assert.equal(
			transformMathDelimiters("text\n\n\\[\n\\int x\n\\]\n\nmore"),
			"text\n\n$$\n\\int x\n$$\n\nmore",
		);
	});

	it("pads mid-paragraph \\[...\\) with blank lines (forces a clean block)", () => {
		assert.equal(
			transformMathDelimiters("mid \\[x^2\\] para"),
			"mid \n\n$$\nx^2\n$$\n\n para",
		);
	});

	it("degrades indented display math (list items) to the inline form", () => {
		// An indented $$ flow block half-parses inside list continuations; inline keeps the math inside the item.
		assert.equal(
			transformMathDelimiters("- item\n  \\[\n  x^2\n  \\]\n- next"),
			"- item\n  $$x^2$$\n- next",
		);
	});
});

