/** Pure tests for the shared pan/zoom viewport math (components/pan-zoom.ts) */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIT_ZOOM_MAX, fitZoomFor } from "../components/pan-zoom.ts";

describe("fitZoomFor", () => {
	it("binds on the axis that runs out of room (wide box → width)", () => {
		assert.equal(fitZoomFor({ w: 800, h: 400 }, { w: 400, h: 300 }), 384 / 800);
	});

	it("binds on height for a tall box", () => {
		assert.equal(fitZoomFor({ w: 400, h: 800 }, { w: 400, h: 300 }), 284 / 800);
	});

	it("caps the fit at FIT_ZOOM_MAX — a tiny box must not blow up", () => {
		assert.equal(fitZoomFor({ w: 50, h: 50 }, { w: 1000, h: 1000 }), FIT_ZOOM_MAX);
	});
});
