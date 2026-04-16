/**
 * Extract pipeline step — the second pipeline step that takes ingested PDF
 * sources and produces structured layout data with spatial information and
 * page images to GCS.
 *
 * Three extraction paths based on native text ratio:
 * - Native text path (ratio >= threshold): local pdf-parse + pdf-to-img
 * - Document AI path (ratio < threshold): Document AI Layout Parser
 * - Gemini Vision fallback: corrects low-confidence Document AI pages
 *
 * @see docs/specs/19_extract_step.spec.md
 * @see docs/functional-spec.md §2.2
 */

import { performance } from 'node:perf_hooks';
import type { DocumentAiResult, Logger, MulderConfig, Services, StepError } from '@mulder/core';
import {
	createChildLogger,
	EXTRACT_ERROR_CODES,
	ExtractError,
	findSourceById,
	getStepConfigHash,
	renderPrompt,
	resetPipelineStep,
	updateSourceStatus,
	upsertSourceStep,
} from '@mulder/core';
import { PDFParse } from 'pdf-parse';
import type pg from 'pg';
import { layoutToMarkdown } from './layout-to-markdown.js';
import type { ExtractInput, ExtractionData, ExtractResult, LayoutBlock, LayoutDocument, LayoutPage } from './types.js';

export { layoutToMarkdown } from './layout-to-markdown.js';
export type {
	ExtractInput,
	ExtractionData,
	ExtractionMethod,
	ExtractResult,
	LayoutDocument,
	PageExtraction,
} from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STEP_NAME = 'extract';

// ────────────────────────────────────────────────────────────
// Native text extraction (Path A)
// ────────────────────────────────────────────────────────────

/**
 * Extracts text per page using pdf-parse. Returns an array of page texts.
 */
async function extractNativeText(pdfBuffer: Buffer, logger: Logger): Promise<string[]> {
	const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
	const textResult = await parser.getText({ pageJoiner: '' });
	const pageTexts = textResult.pages.map((p) => p.text);
	await parser.destroy();
	logger.debug({ pageCount: pageTexts.length }, 'Native text extracted');
	return pageTexts;
}

/**
 * Renders page images from a PDF buffer using pdfjs-dist + @napi-rs/canvas.
 * Returns an array of PNG buffers, one per page.
 *
 * Both dependencies ship prebuilt binaries with no system-library
 * compilation, so this works on macOS arm64, Linux, and CI without any
 * `brew install` or `apt-get install` step.
 *
 * If rendering fails for an unexpected reason, the function logs the error
 * and returns an empty array so downstream steps can continue with
 * text-only processing.
 */
async function renderPageImages(pdfBuffer: Buffer, logger: Logger): Promise<Buffer[]> {
	try {
		// Dynamic imports keep pdfjs-dist out of the cold-start path for
		// callers that never reach this branch.
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const { createCanvas } = await import('@napi-rs/canvas');

		const loadingTask = pdfjs.getDocument({
			data: new Uint8Array(pdfBuffer),
			useSystemFonts: true,
			isEvalSupported: false,
		});
		const doc = await loadingTask.promise;

		const pages: Buffer[] = [];
		const scale = 2;

		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const viewport = page.getViewport({ scale });
			const width = Math.ceil(viewport.width);
			const height = Math.ceil(viewport.height);

			// @napi-rs/canvas implements the HTMLCanvasElement contract at
			// runtime; the structural cast lets pdfjs-dist render into it
			// without pulling DOM types into the tsconfig.
			const napiCanvas = createCanvas(width, height);
			// biome-ignore lint/suspicious/noExplicitAny: cross-runtime canvas type bridge
			await page.render({ canvas: napiCanvas as any, viewport }).promise;

			pages.push(napiCanvas.toBuffer('image/png'));
			page.cleanup();
		}

		await doc.cleanup();
		await doc.destroy();

		logger.debug({ pageCount: pages.length }, 'Page images rendered via pdfjs-dist + @napi-rs/canvas');
		return pages;
	} catch (error: unknown) {
		logger.warn({ err: error }, 'PDF page rendering failed — downstream steps will run text-only');
		return [];
	}
}

// ────────────────────────────────────────────────────────────
// Document AI parsing helpers
// ────────────────────────────────────────────────────────────

interface ParsedDocumentAiPage {
	pageNumber: number;
	text: string;
	confidence: number;
	blocks: LayoutBlock[];
}

/**
 * Type guard: checks if a value is a non-null, non-array object (i.e. a record).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safely extracts a numeric field from a record, with a default fallback.
 */
function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
	const val = obj[key];
	if (typeof val === 'number') return val;
	if (typeof val === 'string') return Number.parseInt(val, 10) || fallback;
	return fallback;
}

/**
 * Parses a Document AI result into per-page extraction data.
 * Extracts text, confidence, and block-level bounding boxes from the raw JSON.
 */
function parseDocumentAiResult(document: Record<string, unknown>): ParsedDocumentAiPage[] {
	const pages: ParsedDocumentAiPage[] = [];

	// Document AI response has a 'pages' array and a top-level 'text' field
	const docText = typeof document.text === 'string' ? document.text : '';
	const rawPages = Array.isArray(document.pages) ? document.pages : [];

	for (let i = 0; i < rawPages.length; i++) {
		const rawPage = isRecord(rawPages[i]) ? rawPages[i] : {};

		// Extract page-level confidence (layout.confidence or overall)
		let pageConfidence = 0.5;
		if (isRecord(rawPage.layout)) {
			pageConfidence = getNumber(rawPage.layout, 'confidence', 0.5);
		}

		// Extract blocks (paragraphs) with bounding boxes
		const blocks: LayoutBlock[] = [];
		const rawParagraphs = Array.isArray(rawPage.paragraphs) ? rawPage.paragraphs : [];

		for (const rawParagraph of rawParagraphs) {
			if (!isRecord(rawParagraph)) continue;

			const paraLayout = rawParagraph.layout;
			if (!isRecord(paraLayout)) continue;

			// Extract text via textAnchor
			let blockText = '';
			const textAnchorCandidate = paraLayout.textAnchor ?? rawParagraph.textAnchor;
			if (isRecord(textAnchorCandidate)) {
				const textSegments = Array.isArray(textAnchorCandidate.textSegments) ? textAnchorCandidate.textSegments : [];
				for (const seg of textSegments) {
					if (!isRecord(seg)) continue;
					const startIndex = getNumber(seg, 'startIndex', 0);
					const endIndex = getNumber(seg, 'endIndex', 0);
					blockText += docText.slice(startIndex, endIndex);
				}
			}

			// Extract bounding box
			let boundingBox: LayoutBlock['boundingBox'];
			const bpCandidate = paraLayout.boundingPoly ?? rawParagraph.boundingPoly;
			if (isRecord(bpCandidate)) {
				const normalizedVertices = Array.isArray(bpCandidate.normalizedVertices) ? bpCandidate.normalizedVertices : [];
				if (normalizedVertices.length >= 4) {
					const vertices = normalizedVertices.map((v) => {
						if (isRecord(v)) {
							return {
								x: typeof v.x === 'number' ? v.x : 0,
								y: typeof v.y === 'number' ? v.y : 0,
							};
						}
						return { x: 0, y: 0 };
					});
					const xs = vertices.map((v) => v.x);
					const ys = vertices.map((v) => v.y);
					boundingBox = {
						x: Math.min(...xs),
						y: Math.min(...ys),
						width: Math.max(...xs) - Math.min(...xs),
						height: Math.max(...ys) - Math.min(...ys),
					};
				}
			}

			const blockConfidence = getNumber(paraLayout, 'confidence', pageConfidence);

			blocks.push({
				text: blockText,
				type: 'paragraph',
				boundingBox,
				confidence: blockConfidence,
			});
		}

		// Build full-page text from blocks, or fall back to text segment extraction
		const pageText = blocks.length > 0 ? blocks.map((b) => b.text).join('\n') : '';

		pages.push({
			pageNumber: i + 1,
			text: pageText,
			confidence: pageConfidence,
			blocks,
		});
	}

	return pages;
}

// ────────────────────────────────────────────────────────────
// Vision fallback
// ────────────────────────────────────────────────────────────

interface VisionFallbackContext {
	services: Services;
	config: MulderConfig;
	logger: Logger;
	maxVisionPages: number;
}

/**
 * Runs Gemini Vision fallback on low-confidence pages.
 * Respects the circuit breaker (max_vision_pages).
 *
 * Mutates the pages array in place, updating text and method for corrected pages.
 * Returns the number of pages corrected and whether the cap was hit.
 */
async function runVisionFallback(
	pages: LayoutPage[],
	pageImages: Buffer[],
	confidenceThreshold: number,
	ctx: VisionFallbackContext,
): Promise<{ visionFallbackCount: number; visionFallbackCapped: boolean; errors: StepError[] }> {
	let visionFallbackCount = 0;
	let visionFallbackCapped = false;
	const errors: StepError[] = [];
	const locale = ctx.config.project.supported_locales[0] ?? 'en';

	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		if (page.confidence >= confidenceThreshold) continue;
		if (page.method === 'vision_fallback') continue; // Already corrected

		if (visionFallbackCount >= ctx.maxVisionPages) {
			visionFallbackCapped = true;
			ctx.logger.warn(
				{ pageNumber: page.pageNumber, maxVisionPages: ctx.maxVisionPages },
				'Vision fallback circuit breaker hit — using Document AI text as-is for remaining pages',
			);
			break;
		}

		// Need a page image for the vision call
		const pageImage = pageImages[i];
		if (!pageImage || pageImage.length === 0) {
			ctx.logger.warn({ pageNumber: page.pageNumber }, 'No page image available for vision fallback — skipping');
			continue;
		}

		try {
			const prompt = renderPrompt('vision-fallback', {
				locale,
				confidence: String(page.confidence),
				page_text: page.text,
			});

			const correctedText = await ctx.services.llm.generateText({
				prompt,
				media: [{ mimeType: 'image/png', data: pageImage }],
			});

			if (correctedText.length > 0) {
				page.text = correctedText;
				page.method = 'vision_fallback';
				page.confidence = Math.max(page.confidence, 0.9); // Vision-corrected gets higher confidence
				visionFallbackCount++;
				ctx.logger.info(
					{ pageNumber: page.pageNumber, originalConfidence: pages[i].confidence },
					'Vision fallback corrected page text',
				);
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push({
				code: EXTRACT_ERROR_CODES.EXTRACT_VISION_FALLBACK_FAILED,
				message: `Vision fallback failed for page ${page.pageNumber}: ${message}`,
			});
			ctx.logger.warn(
				{ err: error, pageNumber: page.pageNumber },
				'Vision fallback failed — using Document AI text as-is',
			);
		}
	}

	return { visionFallbackCount, visionFallbackCapped, errors };
}

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing extraction artifacts before re-extraction.
 * Deletes GCS extracted/ prefix and resets the source step.
 */
async function forceCleanup(sourceId: string, services: Services, pool: pg.Pool, logger: Logger): Promise<void> {
	// 1. GCS cleanup (not in DB function)
	const prefix = `extracted/${sourceId}/`;
	const existing = await services.storage.list(prefix);
	for (const path of existing.paths) {
		await services.storage.delete(path);
	}
	logger.debug({ sourceId, deletedFiles: existing.paths.length }, 'Deleted existing extraction artifacts');

	// 2. Atomic DB reset — cascading-deletes stories, chunks, edges, ALL source_steps
	await resetPipelineStep(pool, sourceId, 'extract');
	logger.info({ sourceId }, 'Force cleanup complete — source status reset to ingested');
}

// ────────────────────────────────────────────────────────────
// GCS output helpers
// ────────────────────────────────────────────────────────────

/**
 * Zero-pads a page number to 3 digits.
 */
function padPageNumber(n: number): string {
	return String(n).padStart(3, '0');
}

/**
 * Writes the human-readable layout.md alongside layout.json. The Markdown
 * representation is a derived byproduct of extraction — if the storage write
 * fails, we log a warning and return normally so the overall Extract step
 * still succeeds. The authoritative output is layout.json.
 */
async function writeLayoutMarkdown(
	sourceId: string,
	layoutDoc: LayoutDocument,
	services: Services,
	logger: Logger,
): Promise<void> {
	const markdownUri = `extracted/${sourceId}/layout.md`;
	try {
		const markdown = layoutToMarkdown(layoutDoc);
		await services.storage.upload(markdownUri, markdown, 'text/markdown');
		logger.debug({ markdownUri, bytes: markdown.length }, 'Layout Markdown uploaded');
	} catch (err) {
		logger.warn({ err, markdownUri }, 'Layout Markdown write failed — extract still succeeded');
	}
}

/**
 * Writes layout.json and page images to GCS.
 * Returns the GCS URIs.
 */
async function writeToStorage(
	sourceId: string,
	layoutDoc: LayoutDocument,
	pageImages: Buffer[],
	services: Services,
	logger: Logger,
): Promise<{ layoutUri: string; pageImageUris: string[] }> {
	const layoutUri = `extracted/${sourceId}/layout.json`;
	await services.storage.upload(layoutUri, JSON.stringify(layoutDoc, null, 2), 'application/json');
	logger.debug({ layoutUri }, 'Layout JSON uploaded');

	// Write the human-readable Markdown view alongside layout.json. This is a
	// byproduct, not a core output — failures must never fail the Extract step.
	await writeLayoutMarkdown(sourceId, layoutDoc, services, logger);

	const pageImageUris: string[] = [];
	for (let i = 0; i < pageImages.length; i++) {
		const imageBuffer = pageImages[i];
		if (!imageBuffer || imageBuffer.length === 0) continue;
		const uri = `extracted/${sourceId}/pages/page-${padPageNumber(i + 1)}.png`;
		await services.storage.upload(uri, imageBuffer, 'image/png');
		pageImageUris.push(uri);
	}
	logger.debug({ pageImageCount: pageImageUris.length }, 'Page images uploaded');

	return { layoutUri, pageImageUris };
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the extract pipeline step.
 *
 * Accepts a source ID, downloads the PDF, chooses the extraction path
 * based on native text ratio, and outputs layout.json + page images to GCS.
 *
 * @param input - Extract input (sourceId, force, fallbackOnly)
 * @param config - Validated Mulder configuration
 * @param services - Service registry (storage, documentAi, llm, firestore)
 * @param pool - PostgreSQL connection pool
 * @param logger - Logger instance
 * @returns Extract result
 */
export async function execute(
	input: ExtractInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<ExtractResult> {
	const log = createChildLogger(logger, { step: STEP_NAME, sourceId: input.sourceId });
	const startTime = performance.now();
	const stepConfigHash = getStepConfigHash(config, STEP_NAME);

	log.info({ force: input.force ?? false, fallbackOnly: input.fallbackOnly ?? false }, 'Extract step started');

	if (!pool) {
		throw new ExtractError('Database pool is required for extract step', EXTRACT_ERROR_CODES.EXTRACT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	// 1. Load source
	const source = await findSourceById(pool, input.sourceId);
	if (!source) {
		throw new ExtractError(`Source not found: ${input.sourceId}`, EXTRACT_ERROR_CODES.EXTRACT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	// 2. Validate status
	const validStatuses = ['ingested', 'extracted', 'segmented', 'enriched', 'embedded', 'graphed', 'analyzed'];
	if (!validStatuses.includes(source.status)) {
		throw new ExtractError(
			`Source ${input.sourceId} has invalid status "${source.status}" for extraction — must be at least "ingested"`,
			EXTRACT_ERROR_CODES.EXTRACT_INVALID_STATUS,
			{ context: { sourceId: input.sourceId, status: source.status } },
		);
	}

	// Already extracted and no --force? Skip.
	if (source.status !== 'ingested' && !input.force && !input.fallbackOnly) {
		log.info({ status: source.status }, 'Source already extracted — skipping (use --force to re-extract)');
		return {
			status: 'success',
			data: null,
			errors: [],
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: source.pageCount ?? 0,
				items_cached: 0,
			},
		};
	}

	// 3. Force cleanup if --force
	if (input.force && source.status !== 'ingested') {
		await forceCleanup(input.sourceId, services, pool, log);
	}

	const errors: StepError[] = [];
	let extractionData: ExtractionData;

	// ── Path C: Fallback only ────────────────────────────
	if (input.fallbackOnly) {
		log.info('Running vision fallback only on existing extraction');

		// Download existing layout.json
		const layoutUri = `extracted/${input.sourceId}/layout.json`;
		let existingLayout: LayoutDocument;
		try {
			const layoutBuffer = await services.storage.download(layoutUri);
			existingLayout = JSON.parse(layoutBuffer.toString('utf-8'));
		} catch (cause: unknown) {
			throw new ExtractError(
				`Cannot run fallback-only: layout.json not found for source ${input.sourceId}`,
				EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
				{ cause, context: { sourceId: input.sourceId, layoutUri } },
			);
		}

		// Download existing page images
		const pageImages: Buffer[] = [];
		for (let i = 0; i < existingLayout.pageCount; i++) {
			const imageUri = `extracted/${input.sourceId}/pages/page-${padPageNumber(i + 1)}.png`;
			try {
				pageImages.push(await services.storage.download(imageUri));
			} catch {
				pageImages.push(Buffer.alloc(0));
			}
		}

		// Run vision fallback on low-confidence pages
		const fallbackResult = await runVisionFallback(
			existingLayout.pages,
			pageImages,
			config.extraction.confidence_threshold,
			{
				services,
				config,
				logger: log,
				maxVisionPages: config.extraction.max_vision_pages,
			},
		);

		existingLayout.metadata.visionFallbackCount += fallbackResult.visionFallbackCount;
		existingLayout.metadata.visionFallbackCapped = fallbackResult.visionFallbackCapped;
		errors.push(...fallbackResult.errors);

		// Re-upload updated layout.json and refresh the derived layout.md.
		await services.storage.upload(layoutUri, JSON.stringify(existingLayout, null, 2), 'application/json');
		await writeLayoutMarkdown(input.sourceId, existingLayout, services, log);

		extractionData = {
			sourceId: input.sourceId,
			layoutUri,
			pageImageUris: pageImages.map((_, i) => `extracted/${input.sourceId}/pages/page-${padPageNumber(i + 1)}.png`),
			pageCount: existingLayout.pageCount,
			primaryMethod: existingLayout.primaryMethod,
			pages: existingLayout.pages.map((p) => ({
				pageNumber: p.pageNumber,
				method: p.method,
				confidence: p.confidence,
				text: p.text,
			})),
			visionFallbackCount: existingLayout.metadata.visionFallbackCount,
			visionFallbackCapped: existingLayout.metadata.visionFallbackCapped,
		};
	} else {
		// ── Path A or B: Full extraction ────────────────────
		// 3. Download PDF
		const storagePath = source.storagePath;
		let pdfBuffer: Buffer;
		try {
			pdfBuffer = await services.storage.download(storagePath);
		} catch (cause: unknown) {
			throw new ExtractError(
				`Failed to download PDF for source ${input.sourceId}`,
				EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
				{ cause, context: { sourceId: input.sourceId, storagePath } },
			);
		}

		// 4. Choose extraction path
		const nativeTextRatio = source.nativeTextRatio;
		const threshold = config.extraction.native_text_threshold;
		const isNativePath = nativeTextRatio >= threshold;

		log.info({ nativeTextRatio, threshold, path: isNativePath ? 'native' : 'document_ai' }, 'Extraction path selected');

		const layoutPages: LayoutPage[] = [];
		let pageImages: Buffer[] = [];
		let primaryMethod: 'native' | 'document_ai';
		let documentAiRaw: Record<string, unknown> | undefined;
		let visionFallbackCount = 0;
		let visionFallbackCapped = false;

		if (isNativePath) {
			// ── Path A: Native text ───────────────────────────
			primaryMethod = 'native';

			try {
				const pageTexts = await extractNativeText(pdfBuffer, log);

				for (let i = 0; i < pageTexts.length; i++) {
					layoutPages.push({
						pageNumber: i + 1,
						method: 'native',
						confidence: 1.0,
						text: pageTexts[i],
					});
				}
			} catch (cause: unknown) {
				throw new ExtractError(
					`Native text extraction failed for source ${input.sourceId}`,
					EXTRACT_ERROR_CODES.EXTRACT_NATIVE_TEXT_FAILED,
					{ cause, context: { sourceId: input.sourceId } },
				);
			}

			// Render page images from PDF
			try {
				pageImages = await renderPageImages(pdfBuffer, log);
			} catch (cause: unknown) {
				log.warn({ err: cause }, 'Page image rendering failed — continuing without images');
			}
		} else {
			// ── Path B: Document AI ───────────────────────────
			primaryMethod = 'document_ai';

			let docAiResult: DocumentAiResult;
			try {
				docAiResult = await services.documentAi.processDocument(pdfBuffer, input.sourceId);
			} catch (cause: unknown) {
				throw new ExtractError(
					`Document AI processing failed for source ${input.sourceId}`,
					EXTRACT_ERROR_CODES.EXTRACT_DOCUMENT_AI_FAILED,
					{ cause, context: { sourceId: input.sourceId } },
				);
			}

			documentAiRaw = docAiResult.document;
			pageImages = docAiResult.pageImages;

			// Parse the Document AI result into per-page data
			const parsedPages = parseDocumentAiResult(docAiResult.document);

			for (const parsed of parsedPages) {
				layoutPages.push({
					pageNumber: parsed.pageNumber,
					method: 'document_ai',
					confidence: parsed.confidence,
					text: parsed.text,
					blocks: parsed.blocks,
				});
			}

			// Run Gemini Vision fallback on low-confidence pages
			const fallbackResult = await runVisionFallback(layoutPages, pageImages, config.extraction.confidence_threshold, {
				services,
				config,
				logger: log,
				maxVisionPages: config.extraction.max_vision_pages,
			});

			visionFallbackCount = fallbackResult.visionFallbackCount;
			visionFallbackCapped = fallbackResult.visionFallbackCapped;
			errors.push(...fallbackResult.errors);
		}

		// 5. Build layout document
		const layoutDoc: LayoutDocument = {
			sourceId: input.sourceId,
			pageCount: layoutPages.length,
			primaryMethod,
			extractedAt: new Date().toISOString(),
			pages: layoutPages,
			metadata: {
				visionFallbackCount,
				visionFallbackCapped,
				documentAiRaw: primaryMethod === 'document_ai' ? documentAiRaw : undefined,
			},
		};

		// 6. Write to GCS
		const { layoutUri, pageImageUris } = await writeToStorage(input.sourceId, layoutDoc, pageImages, services, log);

		extractionData = {
			sourceId: input.sourceId,
			layoutUri,
			pageImageUris,
			pageCount: layoutPages.length,
			primaryMethod,
			pages: layoutPages.map((p) => ({
				pageNumber: p.pageNumber,
				method: p.method,
				confidence: p.confidence,
				text: p.text,
			})),
			visionFallbackCount,
			visionFallbackCapped,
		};

		// 7. Update database
		await updateSourceStatus(pool, input.sourceId, 'extracted');
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: 'completed',
			configHash: stepConfigHash,
		});
	}

	// 8. Firestore observability (fire-and-forget)
	services.firestore
		.setDocument('documents', input.sourceId, {
			status: 'extracted',
			extractedAt: new Date().toISOString(),
			primaryMethod: extractionData.primaryMethod,
			pageCount: extractionData.pageCount,
			visionFallbackCount: extractionData.visionFallbackCount,
			visionFallbackCapped: extractionData.visionFallbackCapped,
		})
		.catch(() => {
			// Silently swallow — Firestore is best-effort observability
		});

	// 9. Determine overall status
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (extractionData.pages.length > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	const durationMs = Math.round(performance.now() - startTime);

	log.info(
		{
			status,
			pageCount: extractionData.pageCount,
			primaryMethod: extractionData.primaryMethod,
			visionFallbackCount: extractionData.visionFallbackCount,
			visionFallbackCapped: extractionData.visionFallbackCapped,
			errors: errors.length,
			duration_ms: durationMs,
		},
		'Extract step completed',
	);

	return {
		status,
		data: extractionData,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: extractionData.pageCount,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}
