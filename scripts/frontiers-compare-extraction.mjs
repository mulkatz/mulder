#!/usr/bin/env node
/**
 * Compare per-page text extracted from the Frontiers of Science PDF via
 * two paths:
 *
 *   1. Native text (pdf-parse against the original PDF with the embedded
 *      Canon OCR layer) — the ground truth baseline.
 *   2. Document AI Layout Parser (real GCP, against the stripped image-only
 *      version produced by `frontiers-strip-text.mjs`) — the real OCR
 *      extraction that Mulder's extract step would use if the native path
 *      wasn't bypassing it.
 *
 * Writes two Markdown documents to `docs/reviews/frontiers-docai-comparison/`
 * so Franz can diff them by eye.
 *
 * Cost: one 16-page Document AI Layout Parser call ≈ €0.15. Real GCP call.
 *
 * Usage:
 *   node scripts/frontiers-compare-extraction.mjs
 *
 * Prerequisites:
 *   - `tests/data/pdf/Frontiers_of_Science_1980_v02-5-6.pdf` exists
 *   - `.local/frontiers-stripped.pdf` exists (run frontiers-strip-text.mjs first)
 *   - `mulder.config.yaml` has `gcp.project_id`, `gcp.document_ai.processor_id`
 *   - `gcloud auth application-default login` completed
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const ROOT = resolve(import.meta.dirname, '..');
const ORIGINAL_PDF = resolve(ROOT, 'tests/data/pdf/Frontiers_of_Science_1980_v02-5-6.pdf');
const STRIPPED_PDF = resolve(ROOT, '.local/frontiers-stripped.pdf');
const OUTPUT_DIR = resolve(ROOT, 'docs/reviews/frontiers-docai-comparison');
const NATIVE_OUT = resolve(OUTPUT_DIR, 'native-canon-text.md');
const DOCAI_OUT = resolve(OUTPUT_DIR, 'document-ai-text.md');
const DOCAI_RAW_OUT = resolve(ROOT, '.local/frontiers-docai-raw.json');

if (!existsSync(ORIGINAL_PDF)) {
	console.error(`original PDF not found: ${ORIGINAL_PDF}`);
	process.exit(1);
}
if (!existsSync(STRIPPED_PDF)) {
	console.error(`stripped PDF not found: ${STRIPPED_PDF} — run frontiers-strip-text.mjs first`);
	process.exit(1);
}
if (!existsSync(OUTPUT_DIR)) {
	mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ─── 1. Native text via pdf-parse ──────────────────────────────────────────

console.log('Extracting native text via pdf-parse…');
const { PDFParse } = await import(
	resolve(ROOT, 'node_modules/.pnpm/pdf-parse@2.4.5/node_modules/pdf-parse/dist/pdf-parse/esm/PDFParse.js')
);
const origBuffer = readFileSync(ORIGINAL_PDF);
const parser = new PDFParse({ data: new Uint8Array(origBuffer) });
const nativeResult = await parser.getText({ pageJoiner: '' });
await parser.destroy();

const nativeMd = buildMarkdown({
	title: 'Frontiers of Science 1980 v02-5-6 — Native Canon-Embedded Text',
	subtitle:
		'Source: `tests/data/pdf/Frontiers_of_Science_1980_v02-5-6.pdf` · extracted via `pdf-parse` (the same library `mulder extract` uses for Path A)',
	pages: nativeResult.pages.map((p, i) => ({
		number: i + 1,
		text: p.text ?? '',
	})),
});
writeFileSync(NATIVE_OUT, nativeMd);
console.log(`  ✅ ${NATIVE_OUT}`);
console.log(`  ${nativeResult.pages.length} pages, ${nativeMd.length.toLocaleString()} markdown chars`);

// ─── 2. Document AI extraction via real GCP ────────────────────────────────

console.log('\nExtracting via real GCP Document AI Layout Parser…');
console.log('(one-time ~€0.15 cost)');

// Bypass mulder's service registry and call DocumentProcessorServiceClient
// directly. The shared `getDocumentAIClient()` initializes against the
// default (global → us) endpoint and the processor 66cbfd75679f38a8 lives
// in the eu multi-region — that mismatch is a separate latent bug that the
// B-7 schema fix did not address. Tracking it as a follow-up; for now this
// script wires up the client explicitly with the eu endpoint so we get the
// real comparison.
const coreModule = await import(resolve(ROOT, 'packages/core/dist/index.js'));
const { loadConfig } = coreModule;

const baseConfig = loadConfig(resolve(ROOT, 'mulder.config.yaml'));
const projectId = baseConfig.gcp.project_id;
const processorId = baseConfig.gcp.document_ai.processor_id;
const location = 'eu';
const processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;
console.log(`  processor: ${processorName}`);

const docaiSdkPath = resolve(
	ROOT,
	'node_modules/.pnpm/@google-cloud+documentai@9.6.0/node_modules/@google-cloud/documentai/build/src/index.js',
);
const { DocumentProcessorServiceClient } = require(docaiSdkPath);
const client = new DocumentProcessorServiceClient({ apiEndpoint: `${location}-documentai.googleapis.com` });

const strippedBuffer = readFileSync(STRIPPED_PDF);
console.log(`  stripped PDF: ${(strippedBuffer.length / 1024 / 1024).toFixed(2)} MB`);

const start = Date.now();
const [response] = await client.processDocument({
	name: processorName,
	rawDocument: {
		content: strippedBuffer,
		mimeType: 'application/pdf',
	},
});
const elapsedMs = Date.now() - start;
console.log(`  Document AI call completed in ${(elapsedMs / 1000).toFixed(1)}s`);

const docaiDocument = response.document ?? {};
// Save the raw Document AI JSON for future inspection (gitignored).
writeFileSync(DOCAI_RAW_OUT, JSON.stringify(docaiDocument, null, 2));
console.log(`  raw JSON → ${DOCAI_RAW_OUT} (${(JSON.stringify(docaiDocument).length / 1024 / 1024).toFixed(2)} MB)`);

const docaiResult = { document: docaiDocument };

// ─── 3. Parse Document AI JSON into per-page text ──────────────────────────

const docaiPages = extractPagesFromDocaiJson(docaiResult.document);

const docaiMd = buildMarkdown({
	title: 'Frontiers of Science 1980 v02-5-6 — Document AI OCR',
	subtitle: `Source: \`.local/frontiers-stripped.pdf\` (image-only reconstruction of the original, no text layer) · extracted via Google Document AI Layout Parser at \`${processorName}\` · 16 pages, ${(elapsedMs / 1000).toFixed(1)}s wall-clock`,
	pages: docaiPages,
});
writeFileSync(DOCAI_OUT, docaiMd);
console.log(`  ✅ ${DOCAI_OUT}`);
console.log(`  ${docaiPages.length} pages, ${docaiMd.length.toLocaleString()} markdown chars`);

console.log('\nDone. Open both files side by side to compare:');
console.log(`  ${NATIVE_OUT}`);
console.log(`  ${DOCAI_OUT}`);

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildMarkdown({ title, subtitle, pages }) {
	const lines = [`# ${title}`, '', subtitle, ''];
	for (const page of pages) {
		lines.push('---', '', `## Page ${page.number}`, '', '```text', page.text.trim() || '(empty)', '```', '');
	}
	return lines.join('\n');
}

/**
 * Extract per-page text from a Document AI Layout Parser response.
 *
 * The Layout Parser response uses `documentLayout.blocks[]`, where each
 * block has `blockId`, `pageSpan: { pageStart, pageEnd }`, and a `textBlock`
 * containing the rendered text plus semantic type (paragraph, heading-1,
 * heading-2, list-item, table, …) and optional nested `textBlock.blocks[]`
 * for nested structures (like list items inside a list).
 *
 * We walk the tree recursively, group by `pageSpan.pageStart`, and render
 * each block with its semantic type as a Markdown-flavored prefix so the
 * comparison shows both the text content AND the structural intent the
 * Layout Parser inferred.
 */
function extractPagesFromDocaiJson(doc) {
	const docLayout = doc.documentLayout ?? {};
	const blocks = Array.isArray(docLayout.blocks) ? docLayout.blocks : [];

	const pageMap = new Map(); // pageNumber → array of formatted lines
	for (const block of blocks) {
		walkBlock(block, pageMap, 0);
	}

	const pageNumbers = Array.from(pageMap.keys()).sort((a, b) => a - b);
	return pageNumbers.map((pn) => ({
		number: pn,
		text: pageMap.get(pn).join('\n'),
	}));
}

function walkBlock(block, pageMap, depth) {
	if (!block) return;
	const pageSpan = block.pageSpan ?? {};
	const pageNumber = typeof pageSpan.pageStart === 'number' ? pageSpan.pageStart : 1;
	const textBlock = block.textBlock;

	if (textBlock && typeof textBlock.text === 'string' && textBlock.text.trim()) {
		const type = textBlock.type ?? 'block';
		const indent = '  '.repeat(depth);
		const prefix = formatBlockPrefix(type);
		const line = `${indent}${prefix}${textBlock.text.trim()}`;
		if (!pageMap.has(pageNumber)) pageMap.set(pageNumber, []);
		pageMap.get(pageNumber).push(line);
	}

	// Recurse into nested children — Layout Parser sometimes nests structural
	// blocks (lists with items, tables with cells, etc.).
	const nested = Array.isArray(textBlock?.blocks) ? textBlock.blocks : [];
	for (const child of nested) {
		walkBlock(child, pageMap, depth + 1);
	}
}

function formatBlockPrefix(type) {
	switch (type) {
		case 'heading-1':
			return '# ';
		case 'heading-2':
			return '## ';
		case 'heading-3':
			return '### ';
		case 'heading-4':
			return '#### ';
		case 'list-item':
			return '- ';
		case 'table':
			return '[TABLE] ';
		case 'caption':
			return '[CAPTION] ';
		case 'paragraph':
			return '';
		default:
			return `[${type}] `;
	}
}
