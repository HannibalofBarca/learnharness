/** MODEL-VALUE DEBRIS STRIP: glm-5.3 emitted `correctAnswer: [":parmenides"]` — the option value with the JSON key-value COLON glued on */

/** Strip the copy-syntax debris a model glues onto a membership value: any run of surrounding whitespace, colons, double/single quotes, and backticks */
export function stripModelValueDebris(value: string): string {
	return value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
}
