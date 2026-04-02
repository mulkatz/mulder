/**
 * Fixture generation orchestrator.
 *
 * Scans for test PDFs, runs real GCP services against them, and captures
 * API responses as committed fixtures. These fixtures serve both dev mode
 * (zero-cost iteration) and tests (real response structures).
 *
 * The orchestrator bypasses the dev-mode registry and always uses real
 * GCP services via `createGcpServices()` directly.
 *
 * @see docs/specs/20_fixture_generator.spec.md §4.3
 * @see docs/functional-spec.md §11, §9.1
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, MulderConfig, Services } from '@mulder/core';
import type {
	FixtureArtifact,
	FixtureError,
	FixtureGenerateInput,
	FixtureGenerateResult,
	FixtureSourceStatus,
} from './types.js';
import { writeExtractFixtures } from './writers.js';

export type {
	FixtureArtifact,
	FixtureError,
	FixtureGenerateInput,
	FixtureGenerateResult,
	FixtureSourceStatus,
} from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

/** Supported fixture generation steps. */
const SUPPORTED_STEPS = ['extract'] as const;

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Derives a source slug from a PDF filename.
 * Strips the `.pdf` extension and returns the rest.
 */
function deriveSlug(filename: string): string {
	return filename.replace(/\.pdf$/i, '');
}

/**
 * Scans a directory for PDF files.
 * Returns sorted list of filenames (not full paths).
 */
function discoverPdfs(inputDir: string): string[] {
	if (!existsSync(inputDir)) {
		return [];
	}
	return readdirSync(inputDir)
		.filter((f) => f.toLowerCase().endsWith('.pdf'))
		.sort();
}

/**
 * Checks whether extracted fixtures already exist for a slug.
 */
function hasExtractedFixtures(outputDir: string, slug: string): boolean {
	const layoutPath = join(outputDir, 'extracted', slug, 'layout.json');
	return existsSync(layoutPath);
}

// ────────────────────────────────────────────────────────────
// README updater
// ────────────────────────────────────────────────────────────

/**
 * Updates the API version tracking table in `fixtures/README.md`.
 *
 * Parses the existing markdown table, updates the "Last Generated" column
 * for the specified directory row with the current ISO date.
 */
function updateReadmeTable(outputDir: string, directory: string, logger: Logger): void {
	const readmePath = join(outputDir, 'README.md');
	if (!existsSync(readmePath)) {
		logger.warn({ readmePath }, 'fixtures/README.md not found — skipping table update');
		return;
	}

	const content = readFileSync(readmePath, 'utf-8');
	const today = new Date().toISOString().split('T')[0];

	// Match the table row for the given directory and update "Last Generated"
	// Table format: | `extracted/` | API | Version | Last Generated |
	const escapedDir = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const rowPattern = new RegExp(`(\\|\\s*\`${escapedDir}\`\\s*\\|[^|]*\\|[^|]*\\|)\\s*[^|]*\\|`);

	const match = rowPattern.exec(content);
	if (!match) {
		logger.warn({ directory }, 'Could not find table row for directory in README.md');
		return;
	}

	const updated = content.replace(rowPattern, `$1 ${today} |`);
	writeFileSync(readmePath, updated, 'utf-8');
	logger.info({ directory, date: today }, 'Updated README.md API version tracking table');
}

// ────────────────────────────────────────────────────────────
// Generate
// ────────────────────────────────────────────────────────────

/**
 * Generates fixture artifacts from real GCP API responses.
 *
 * Scans the input directory for PDF files, runs available pipeline steps
 * using real GCP services, and writes captured artifacts to the output
 * fixture directory.
 *
 * @param input - Generation options (directories, force, step filter).
 * @param services - GCP service bundle (must be real, not dev-mode).
 * @param config - Validated Mulder configuration.
 * @param logger - Logger instance.
 * @returns Generation result with artifacts, skipped files, and errors.
 */
export async function generateFixtures(
	input: FixtureGenerateInput,
	services: Services,
	_config: MulderConfig,
	logger: Logger,
): Promise<FixtureGenerateResult> {
	const { inputDir, outputDir, force, step } = input;

	// Validate step filter
	if (step && !SUPPORTED_STEPS.includes(step as (typeof SUPPORTED_STEPS)[number])) {
		return {
			status: 'failed',
			generated: [],
			skipped: [],
			errors: [
				{
					sourceSlug: '',
					step: step,
					message: `Unsupported step "${step}". Supported steps: ${SUPPORTED_STEPS.join(', ')}`,
				},
			],
		};
	}

	// Discover PDFs
	const pdfFiles = discoverPdfs(inputDir);
	if (pdfFiles.length === 0) {
		logger.warn({ inputDir }, 'No PDF files found in input directory');
		return {
			status: 'success',
			generated: [],
			skipped: [],
			errors: [],
		};
	}

	logger.info({ inputDir, pdfCount: pdfFiles.length }, 'Discovered PDF files');

	const generated: FixtureArtifact[] = [];
	const skipped: string[] = [];
	const errors: FixtureError[] = [];

	// Determine which steps to run
	const stepsToRun = step ? [step] : [...SUPPORTED_STEPS];

	for (const pdfFile of pdfFiles) {
		const slug = deriveSlug(pdfFile);
		const pdfPath = join(inputDir, pdfFile);

		logger.info({ slug, pdfFile }, 'Processing PDF');

		for (const currentStep of stepsToRun) {
			if (currentStep === 'extract') {
				// Check if fixtures already exist
				if (!force && hasExtractedFixtures(outputDir, slug)) {
					logger.info({ slug }, 'Extract fixtures already exist — skipping (use --force to regenerate)');
					skipped.push(slug);
					continue;
				}

				try {
					// Read PDF content
					const pdfBuffer = readFileSync(pdfPath);

					// Call Document AI directly (no database needed)
					logger.info({ slug }, 'Calling Document AI...');
					const result = await services.documentAi.processDocument(pdfBuffer, slug);

					// Write fixtures
					const paths = writeExtractFixtures(slug, result, outputDir, logger);

					generated.push({
						sourceSlug: slug,
						step: 'extract',
						paths,
					});

					logger.info(
						{ slug, pageCount: result.pageImages.length, artifactCount: paths.length },
						'Extract fixtures generated',
					);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					logger.error({ err: error, slug }, 'Failed to generate extract fixtures');
					errors.push({
						sourceSlug: slug,
						step: 'extract',
						message,
					});
				}
			}
		}
	}

	// Update README.md table for generated steps
	const generatedSteps = new Set(generated.map((a) => a.step));
	if (generatedSteps.has('extract')) {
		updateReadmeTable(outputDir, 'extracted/', logger);
	}

	// Determine overall status
	let status: FixtureGenerateResult['status'];
	if (errors.length === 0) {
		status = 'success';
	} else if (generated.length > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	return { status, generated, skipped, errors };
}

// ────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────

/**
 * Gets the modification time of a file or directory.
 * Returns null if the path does not exist.
 */
function getModifiedTime(filePath: string): Date | null {
	try {
		return statSync(filePath).mtime;
	} catch {
		return null;
	}
}

/**
 * Returns the fixture status for all source PDFs.
 *
 * Shows which fixture types exist for each PDF, their last modified dates,
 * and whether fixtures are stale (older than the source PDF).
 *
 * @param fixturesDir - Root fixtures directory (default: `fixtures/`).
 * @returns Array of status objects, one per source PDF.
 */
export function getFixtureStatus(fixturesDir: string): FixtureSourceStatus[] {
	const rawDir = join(fixturesDir, 'raw');
	const pdfFiles = discoverPdfs(rawDir);

	return pdfFiles.map((pdfFile) => {
		const slug = deriveSlug(pdfFile);
		const pdfPath = join(rawDir, pdfFile);
		const pdfModified = statSync(pdfPath).mtime;

		// Check for each fixture type
		const extractedDir = join(fixturesDir, 'extracted', slug);
		const hasExtracted = existsSync(join(extractedDir, 'layout.json'));
		const extractedModified = hasExtracted ? getModifiedTime(join(extractedDir, 'layout.json')) : null;

		const hasSegments = existsSync(join(fixturesDir, 'segments', slug));
		const hasEntities = existsSync(join(fixturesDir, 'entities', slug));
		const hasEmbeddings = existsSync(join(fixturesDir, 'embeddings', slug));
		const hasGrounding = existsSync(join(fixturesDir, 'grounding', slug));

		// A fixture is stale if it exists but is older than the source PDF
		const isStale = extractedModified !== null && extractedModified < pdfModified;

		return {
			slug,
			hasExtracted,
			hasSegments,
			hasEntities,
			hasEmbeddings,
			hasGrounding,
			pdfModified,
			extractedModified,
			isStale,
		};
	});
}
