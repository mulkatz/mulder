#!/usr/bin/env node

/**
 * Strip the embedded text layer from the Frontiers of Science PDF by
 * rasterizing each page to a PNG and reassembling the pages as an
 * image-only PDF. The result is bit-identical visually but contains
 * zero text objects — `pdftotext` returns empty, and Mulder's extract
 * step routes to the Document AI path instead of the native-text path.
 *
 * Input:  tests/data/pdf/Frontiers_of_Science_1980_v02-5-6.pdf
 * Output: .local/frontiers-stripped.pdf
 *
 * Usage:
 *   node scripts/frontiers-strip-text.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const ROOT = resolve(import.meta.dirname, '..');
const INPUT_PDF = resolve(ROOT, 'tests/data/pdf/Frontiers_of_Science_1980_v02-5-6.pdf');
const OUTPUT_DIR = resolve(ROOT, '.local');
const OUTPUT_PDF = resolve(OUTPUT_DIR, 'frontiers-stripped.pdf');

if (!existsSync(INPUT_PDF)) {
	console.error(`input PDF not found: ${INPUT_PDF}`);
	process.exit(1);
}

if (!existsSync(OUTPUT_DIR)) {
	mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Load pdfjs-dist + @napi-rs/canvas from the pipeline workspace.
const pdfjs = await import(
	resolve(ROOT, 'node_modules/.pnpm/pdfjs-dist@5.4.296/node_modules/pdfjs-dist/legacy/build/pdf.mjs')
);
const { createCanvas } = await import(
	resolve(ROOT, 'node_modules/.pnpm/@napi-rs+canvas@0.1.80/node_modules/@napi-rs/canvas/index.js')
);
const { PDFDocument } = require(resolve(ROOT, 'node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib/cjs/index.js'));

console.log(`Loading ${INPUT_PDF}`);
const buffer = readFileSync(INPUT_PDF);
console.log(`  ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

console.log('Parsing with pdfjs-dist…');
const loadingTask = pdfjs.getDocument({
	data: new Uint8Array(buffer),
	useSystemFonts: true,
	isEvalSupported: false,
});
const doc = await loadingTask.promise;
console.log(`  ${doc.numPages} pages`);

const scale = 2; // 144 DPI — close enough to Document AI's recommended 200 DPI
const jpegQuality = 85; // JPEG instead of PNG keeps the result under DocAI's 40 MB inline limit
const pageJpegs = [];

for (let i = 1; i <= doc.numPages; i++) {
	const page = await doc.getPage(i);
	const viewport = page.getViewport({ scale });
	const width = Math.ceil(viewport.width);
	const height = Math.ceil(viewport.height);

	const canvas = createCanvas(width, height);
	await page.render({ canvas: /** @type {any} */ (canvas), viewport }).promise;
	pageJpegs.push(canvas.toBuffer('image/jpeg', jpegQuality));
	page.cleanup();

	if (i % 4 === 0 || i === doc.numPages) {
		console.log(`  rendered ${i}/${doc.numPages}`);
	}
}
await doc.cleanup();
await doc.destroy();

console.log('Assembling image-only PDF with pdf-lib…');
const outDoc = await PDFDocument.create();
for (let i = 0; i < pageJpegs.length; i++) {
	const jpg = await outDoc.embedJpg(pageJpegs[i]);
	const { width: jpgW, height: jpgH } = jpg;
	// Use the original page dimensions from the source (612 × 791.76 pts / US Letter)
	// scaled down from the 2x render: divide by `scale`.
	const pageW = jpgW / scale;
	const pageH = jpgH / scale;
	const page = outDoc.addPage([pageW, pageH]);
	page.drawImage(jpg, { x: 0, y: 0, width: pageW, height: pageH });
}

const outBytes = await outDoc.save();
writeFileSync(OUTPUT_PDF, outBytes);
console.log(`\n✅ Written ${OUTPUT_PDF}`);
console.log(`   ${(outBytes.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`   ${pageJpegs.length} pages (image-only, no text layer)`);
