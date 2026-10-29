import * as path from "node:path";
import { fileURLToPath } from "node:url";




/** Standard-font data dir. */
export function standardFontsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + "/";
}











