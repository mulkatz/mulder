/**
 * Artifact writers for fixture generation.
 *
 * Each pipeline step has a dedicated writer that saves captured API
 * responses to the correct fixture directory structure.
 *
 * @see docs/specs/20_fixture_generator.spec.md §4.4
 * @see docs/functional-spec.md §11.2
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentAiResult, Logger } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Extract writer
// ────────────────────────────────────────────────────────────

/**
 * Zero-pads a page number to 3 digits.
 */
function padPageNumber(n: number): string {
	return String(n).padStart(3, '0');
}

/**
 * Writes extracted fixture artifacts for a single source.
 *
 * Creates the directory structure:
 * ```
 * {outputDir}/extracted/{slug}/
 *   layout.json           — pretty-printed Document AI JSON
 *   pages/
 *     page-001.png        — 1-indexed, zero-padded page images
 *     page-002.png
 * ```
 *
 * @param slug - Source slug (derived from PDF filename).
 * @param result - Document AI processing result.
 * @param outputDir - Root output directory (e.g., `fixtures/`).
 * @param logger - Logger instance.
 * @returns List of file paths written (relative to outputDir).
 */
export function writeExtractFixtures(
	slug: string,
	result: DocumentAiResult,
	outputDir: string,
	logger: Logger,
): string[] {
	const writtenPaths: string[] = [];

	// Create extracted/{slug}/ directory
	const slugDir = join(outputDir, 'extracted', slug);
	mkdirSync(slugDir, { recursive: true });

	// Write layout.json (pretty-printed, 2-space indent)
	const layoutPath = join(slugDir, 'layout.json');
	writeFileSync(layoutPath, JSON.stringify(result.document, null, 2), 'utf-8');
	writtenPaths.push(`extracted/${slug}/layout.json`);
	logger.debug({ path: layoutPath }, 'Wrote layout.json');

	// Write page images
	if (result.pageImages.length > 0) {
		const pagesDir = join(slugDir, 'pages');
		mkdirSync(pagesDir, { recursive: true });

		for (let i = 0; i < result.pageImages.length; i++) {
			const pageImage = result.pageImages[i];
			if (!pageImage || pageImage.length === 0) continue;

			const filename = `page-${padPageNumber(i + 1)}.png`;
			const pagePath = join(pagesDir, filename);
			writeFileSync(pagePath, pageImage);
			writtenPaths.push(`extracted/${slug}/pages/${filename}`);
			logger.debug({ path: pagePath }, 'Wrote page image');
		}
	}

	logger.info({ slug, fileCount: writtenPaths.length }, 'Extract fixtures written');

	return writtenPaths;
}
