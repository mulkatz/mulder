import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');

/**
 * Black-box QA tests for Spec 15: Native Text Detection
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through the public API boundary: dynamic import of
 * `@mulder/core` (dist/index.js) and filesystem fixtures.
 * Never imports from packages/ source (src/) directly.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamically import detectNativeText from the built @mulder/core barrel.
 */
async function getDetectFn(): Promise<
	(
		buf: Buffer,
		opts?: { minCharsPerPage?: number },
	) => Promise<{
		hasNativeText: boolean;
		nativeTextRatio: number;
		pageCount: number;
		pagesWithText: number;
	}>
> {
	const core = await import(CORE_DIST);
	if (typeof core.detectNativeText !== 'function') {
		throw new Error('detectNativeText is not exported from @mulder/core');
	}
	return core.detectNativeText;
}

/**
 * Create a mixed PDF using pdf-lib: some pages with text, some without.
 * Returns a Buffer of a 4-page PDF where pages 1 and 3 have text,
 * pages 2 and 4 are blank (image-only simulation).
 */
async function createMixedPdf(): Promise<Buffer> {
	const { PDFDocument, StandardFonts } = await import('pdf-lib');
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);

	// Page 1: substantial text
	const page1 = doc.addPage([612, 792]);
	page1.drawText(
		'This is page one with plenty of text content for detection. It should be counted as having native text.',
		{ x: 50, y: 700, size: 12, font },
	);

	// Page 2: blank (no text at all)
	doc.addPage([612, 792]);

	// Page 3: substantial text
	const page3 = doc.addPage([612, 792]);
	page3.drawText('Page three also contains a reasonable amount of text content that exceeds the character threshold.', {
		x: 50,
		y: 700,
		size: 12,
		font,
	});

	// Page 4: blank (no text at all)
	doc.addPage([612, 792]);

	const bytes = await doc.save();
	return Buffer.from(bytes);
}

/**
 * Create a PDF with a single page containing exactly `charCount` non-whitespace chars.
 * Used for threshold testing.
 */
async function createSparseTextPdf(charCount: number): Promise<Buffer> {
	const { PDFDocument, StandardFonts } = await import('pdf-lib');
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);

	const page = doc.addPage([612, 792]);
	// Generate text with exactly charCount non-whitespace characters
	const text = 'A'.repeat(charCount);
	page.drawText(text, { x: 50, y: 700, size: 10, font });

	const bytes = await doc.save();
	return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 15 — Native Text Detection', () => {
	// QA-01: Detects native text in text-based PDF
	it('QA-01: detects native text in text-based PDF', async () => {
		const detectNativeText = await getDetectFn();
		const pdfBuffer = readFileSync(resolve(ROOT, 'fixtures/raw/native-text-sample.pdf'));

		const result = await detectNativeText(pdfBuffer);

		expect(result.hasNativeText).toBe(true);
		expect(result.nativeTextRatio).toBe(1.0);
	});

	// QA-02: Returns zero ratio for image-only PDF
	it('QA-02: returns zero ratio for image-only PDF', async () => {
		const detectNativeText = await getDetectFn();
		const pdfBuffer = readFileSync(resolve(ROOT, 'fixtures/raw/scanned-sample.pdf'));

		const result = await detectNativeText(pdfBuffer);

		expect(result.hasNativeText).toBe(false);
		expect(result.nativeTextRatio).toBe(0);
	});

	// QA-03: Calculates correct ratio for mixed PDF
	it('QA-03: calculates correct ratio for mixed PDF', async () => {
		const detectNativeText = await getDetectFn();
		const mixedPdf = await createMixedPdf();

		const result = await detectNativeText(mixedPdf);

		expect(result.nativeTextRatio).toBe(0.5);
		expect(result.pageCount).toBe(4);
		expect(result.pagesWithText).toBe(2);
	});

	// QA-04: Returns correct page count
	it('QA-04: returns correct page count', async () => {
		const detectNativeText = await getDetectFn();
		const pdfBuffer = readFileSync(resolve(ROOT, 'fixtures/raw/native-text-sample.pdf'));

		const result = await detectNativeText(pdfBuffer);

		// native-text-sample.pdf is a 3-page PDF per spec
		expect(result.pageCount).toBe(3);
	});

	// QA-05: Respects minCharsPerPage threshold
	it('QA-05: respects minCharsPerPage threshold', async () => {
		const detectNativeText = await getDetectFn();

		// Create a PDF with 10 non-whitespace characters on one page
		const sparsePdf = await createSparseTextPdf(10);

		// Default threshold is 50 — 10 chars should NOT count
		const defaultResult = await detectNativeText(sparsePdf);
		expect(defaultResult.hasNativeText).toBe(false);
		expect(defaultResult.pagesWithText).toBe(0);

		// With threshold 5 — 10 chars SHOULD count
		const lowThresholdResult = await detectNativeText(sparsePdf, {
			minCharsPerPage: 5,
		});
		expect(lowThresholdResult.hasNativeText).toBe(true);
		expect(lowThresholdResult.pagesWithText).toBe(1);
	});

	// QA-06: Handles corrupt PDF gracefully
	it('QA-06: handles corrupt PDF gracefully', async () => {
		const detectNativeText = await getDetectFn();

		// Pass garbage data — should not throw
		const garbageBuffer = Buffer.from('this is not a valid PDF file at all');

		const result = await detectNativeText(garbageBuffer);

		expect(result.hasNativeText).toBe(false);
		expect(result.nativeTextRatio).toBe(0);
		expect(result.pageCount).toBe(0);
		expect(result.pagesWithText).toBe(0);
	});

	// QA-07: Handles empty buffer gracefully
	it('QA-07: handles empty buffer gracefully', async () => {
		const detectNativeText = await getDetectFn();

		const emptyBuffer = Buffer.alloc(0);

		const result = await detectNativeText(emptyBuffer);

		expect(result.hasNativeText).toBe(false);
		expect(result.nativeTextRatio).toBe(0);
		expect(result.pageCount).toBe(0);
		expect(result.pagesWithText).toBe(0);
	});

	// QA-08: Build compiles without errors
	it('QA-08: build compiles without errors', () => {
		const result = execFileSync('pnpm', ['turbo', 'run', 'build'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 120_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// If execFileSync doesn't throw, the build succeeded
		expect(result).toBeDefined();
	});

	// QA-09: Biome lint passes
	it('QA-09: biome lint passes', () => {
		const result = execFileSync('npx', ['biome', 'check', '.'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 60_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// If execFileSync doesn't throw, lint passed
		expect(result).toBeDefined();
	});
});
