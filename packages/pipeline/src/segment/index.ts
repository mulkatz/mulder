/**
 * Segment pipeline step — the third pipeline step that takes extracted
 * layout data and page images, identifies individual stories within
 * multi-article documents via Gemini, and produces per-story Markdown
 * + lean metadata JSON written to GCS. Story records are created in
 * PostgreSQL via the story repository.
 *
 * @see docs/specs/23_segment_step.spec.md
 * @see docs/functional-spec.md §2.3
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { CompactDocumentQualitySummary, Logger, MulderConfig, Services, StepError } from '@mulder/core';
import {
	createChildLogger,
	createStory,
	findLatestDocumentQualityAssessment,
	findSourceById,
	getStepConfigHash,
	renderPrompt,
	resetPipelineStep,
	SEGMENT_ERROR_CODES,
	SegmentError,
	updateSourceStatus,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import type { LayoutDocument, LayoutPage } from '../extract/types.js';
import { buildCompactDocumentQualitySummary } from '../quality/index.js';
import { getSegmentationJsonSchema, type SegmentationResponse, segmentationResponseSchema } from './schema.js';
import type { SegmentationData, SegmentedStory, SegmentInput, SegmentResult } from './types.js';
import {
	buildPreviousWindowContext,
	clampStoryToDocument,
	createSegmentWindows,
	mergeWindowStories,
	type SegmentWindow,
	type WindowedSegmentStory,
} from './windowing.js';

export type { SegmentationData, SegmentedStory, SegmentInput, SegmentResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STEP_NAME = 'segment';

function mergeQualitySummary(
	metadata: Record<string, unknown>,
	qualitySummary?: CompactDocumentQualitySummary | null,
): Record<string, unknown> {
	return qualitySummary ? { ...metadata, ...qualitySummary } : metadata;
}

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing segmentation artifacts before re-segmentation.
 * Deletes all stories for the source (cascade-deletes chunks, edges),
 * GCS segment prefix, and the source step record.
 */
async function forceCleanup(sourceId: string, services: Services, pool: pg.Pool, logger: Logger): Promise<void> {
	// 1. Atomic DB reset — cascading-deletes stories (+ chunks, story_entities, edges), resets source_steps
	await resetPipelineStep(pool, sourceId, 'segment');
	logger.debug({ sourceId }, 'DB reset complete for segment');

	// 2. GCS cleanup (not in DB function)
	const prefix = `segments/${sourceId}/`;
	const existing = await services.storage.list(prefix);
	for (const path of existing.paths) {
		await services.storage.delete(path);
	}
	logger.debug({ sourceId, deletedFiles: existing.paths.length }, 'Deleted existing segment artifacts');

	logger.info({ sourceId }, 'Force cleanup complete — source status reset to extracted');
}

// ────────────────────────────────────────────────────────────
// Layout loading helpers
// ────────────────────────────────────────────────────────────

/**
 * Loads the layout.json from GCS and parses it into a LayoutDocument.
 */
async function loadLayoutDocument(sourceId: string, services: Services): Promise<LayoutDocument> {
	const layoutUri = `extracted/${sourceId}/layout.json`;
	const buffer = await services.storage.download(layoutUri);
	const doc: LayoutDocument = JSON.parse(buffer.toString('utf-8'));
	return doc;
}

/**
 * Loads page images from GCS for the given layout pages.
 * Returns an array of Buffers, one per page. Missing pages get empty buffers.
 */
async function loadPageImages(
	sourceId: string,
	pages: LayoutPage[],
	services: Services,
	logger: Logger,
): Promise<Buffer[]> {
	const images: Buffer[] = [];
	for (const page of pages) {
		const uri = `extracted/${sourceId}/pages/page-${String(page.pageNumber).padStart(3, '0')}.png`;
		try {
			images.push(await services.storage.download(uri));
		} catch {
			logger.warn({ pageNumber: page.pageNumber }, 'Page image not found — skipping');
			images.push(Buffer.alloc(0));
		}
	}
	return images;
}

function buildPageImageMap(pages: LayoutPage[], images: Buffer[]): Map<number, Buffer> {
	const map = new Map<number, Buffer>();
	for (let index = 0; index < pages.length; index += 1) {
		const page = pages[index];
		if (!page) continue;
		map.set(page.pageNumber, images[index] ?? Buffer.alloc(0));
	}
	return map;
}

function buildWindowPrompt(
	basePrompt: string,
	layoutDoc: LayoutDocument,
	window: SegmentWindow<LayoutPage>,
	previousWindowContext: string,
): string {
	const lines = [
		basePrompt,
		'',
		'## Segmentation Window',
		`Pages in this request: ${window.pageStart}-${window.pageEnd} of ${layoutDoc.pageCount}.`,
		'Use original document page numbers for page_start and page_end.',
		'Stories may continue across windows. If visible text continues a previous story, keep the same title and include only the text visible in this window.',
		previousWindowContext,
		'',
		'## Page Content',
	];

	for (const page of window.pages) {
		lines.push(`### Page ${page.pageNumber}`);
		lines.push(page.text);
		lines.push('');
	}

	return lines.filter((line) => line !== '').join('\n');
}

function selectWindowMedia(
	window: SegmentWindow<LayoutPage>,
	pageImageMap: Map<number, Buffer>,
	maxMediaPages: number,
): Array<{ mimeType: string; data: Buffer }> {
	if (maxMediaPages <= 0) return [];
	const media: Array<{ mimeType: string; data: Buffer }> = [];
	for (const page of window.pages) {
		const image = pageImageMap.get(page.pageNumber);
		if (!image || image.length === 0) continue;
		media.push({ mimeType: 'image/png', data: image });
		if (media.length >= maxMediaPages) break;
	}
	return media;
}

interface SegmentCauseDetails {
	name?: string;
	code?: unknown;
	status?: unknown;
	retryable?: unknown;
	message: string;
}

function errorField(cause: unknown, key: string): unknown {
	if (cause !== null && typeof cause === 'object' && key in cause) {
		return (cause as Record<string, unknown>)[key];
	}
	return undefined;
}

function describeSegmentCause(cause: unknown): SegmentCauseDetails {
	if (cause instanceof Error) {
		return {
			name: cause.name,
			code: errorField(cause, 'code'),
			status: errorField(cause, 'status'),
			retryable: errorField(cause, 'retryable'),
			message: cause.message,
		};
	}
	return {
		code: errorField(cause, 'code'),
		status: errorField(cause, 'status'),
		retryable: errorField(cause, 'retryable'),
		message: typeof cause === 'string' ? cause : String(cause),
	};
}

// ────────────────────────────────────────────────────────────
// Segment metadata JSON builder
// ────────────────────────────────────────────────────────────

interface SegmentMetadataJson {
	id: string;
	document_id: string;
	source_type: string;
	title: string;
	subtitle: string | null;
	language: string;
	category: string;
	pages: number[];
	date_references: string[];
	geographic_references: string[];
	extraction_confidence: number;
}

function buildSegmentMetadata(
	storyId: string,
	sourceId: string,
	sourceType: string,
	story: {
		title: string;
		subtitle: string | null;
		language: string;
		category: string;
		page_start: number;
		page_end: number;
		date_references: string[];
		geographic_references: string[];
		confidence: number;
	},
): SegmentMetadataJson {
	const pages: number[] = [];
	for (let p = story.page_start; p <= story.page_end; p++) {
		pages.push(p);
	}

	return {
		id: storyId,
		document_id: sourceId,
		source_type: sourceType,
		title: story.title,
		subtitle: story.subtitle,
		language: story.language,
		category: story.category,
		pages,
		date_references: story.date_references,
		geographic_references: story.geographic_references,
		extraction_confidence: story.confidence,
	};
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the segment pipeline step.
 *
 * Accepts a source ID, loads layout JSON + page images from GCS,
 * sends to Gemini for story identification, and writes per-story
 * Markdown + metadata JSON to GCS. Creates story records in PostgreSQL.
 *
 * @param input - Segment input (sourceId, force)
 * @param config - Validated Mulder configuration
 * @param services - Service registry (storage, llm, firestore)
 * @param pool - PostgreSQL connection pool
 * @param logger - Logger instance
 * @returns Segment result
 */
export async function execute(
	input: SegmentInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<SegmentResult> {
	const log = createChildLogger(logger, { step: STEP_NAME, sourceId: input.sourceId });
	const startTime = performance.now();
	const stepConfigHash = getStepConfigHash(config, STEP_NAME);

	log.info({ force: input.force ?? false }, 'Segment step started');

	if (!pool) {
		throw new SegmentError('Database pool is required for segment step', SEGMENT_ERROR_CODES.SEGMENT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	// 1. Load source
	const source = await findSourceById(pool, input.sourceId);
	if (!source) {
		throw new SegmentError(`Source not found: ${input.sourceId}`, SEGMENT_ERROR_CODES.SEGMENT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	// 2. Validate status — must be at least "extracted"
	const validStatuses = ['extracted', 'segmented', 'enriched', 'embedded', 'graphed', 'analyzed'];
	if (!validStatuses.includes(source.status)) {
		throw new SegmentError(
			`Source ${input.sourceId} has invalid status "${source.status}" for segmentation — must be at least "extracted"`,
			SEGMENT_ERROR_CODES.SEGMENT_INVALID_STATUS,
			{ context: { sourceId: input.sourceId, status: source.status } },
		);
	}

	// Already segmented (or beyond) and no --force? Skip.
	if (source.status !== 'extracted' && !input.force) {
		log.info({ status: source.status }, 'Source already segmented — skipping (use --force to re-segment)');
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

	// 3. Force cleanup if --force and already processed
	if (input.force && source.status !== 'extracted') {
		await forceCleanup(input.sourceId, services, pool, log);
	}

	// 4. Load layout JSON from GCS
	let layoutDoc: LayoutDocument;
	try {
		layoutDoc = await loadLayoutDocument(input.sourceId, services);
	} catch (cause: unknown) {
		throw new SegmentError(
			`Layout JSON not found for source ${input.sourceId} — has it been extracted?`,
			SEGMENT_ERROR_CODES.SEGMENT_LAYOUT_NOT_FOUND,
			{ cause, context: { sourceId: input.sourceId } },
		);
	}

	const segmentationConfig = config.extraction.segmentation;
	const sendPageImages =
		layoutDoc.primaryMethod === 'document_ai'
			? segmentationConfig.send_page_images_for_document_ai
			: segmentationConfig.send_page_images_for_native;

	// 5. Load page images only when this extraction path benefits from visual context.
	const pageImages = sendPageImages ? await loadPageImages(input.sourceId, layoutDoc.pages, services, log) : [];
	const pageImageMap = buildPageImageMap(layoutDoc.pages, pageImages);

	// 6. Build segmentation prompt
	const locale = config.project.supported_locales[0] ?? 'en';

	// Render the base template (page_content is appended separately since
	// the template engine uses simple placeholder interpolation, not Jinja2 for-loops)
	const basePrompt = renderPrompt('segment', {
		locale,
		page_count: String(layoutDoc.pageCount),
		has_native_text: String(layoutDoc.primaryMethod === 'native'),
	});

	const errors: StepError[] = [];
	const windowedStories: WindowedSegmentStory[] = [];
	const windows = createSegmentWindows(layoutDoc.pages, {
		windowPages: segmentationConfig.window_pages,
		overlapPages: segmentationConfig.window_overlap_pages,
	});

	log.info(
		{
			pageCount: layoutDoc.pageCount,
			windows: windows.length,
			windowPages: segmentationConfig.window_pages,
			overlapPages: segmentationConfig.window_overlap_pages,
			sendPageImages,
			maxMediaPagesPerWindow: segmentationConfig.max_media_pages_per_window,
			extractionMethod: layoutDoc.primaryMethod,
		},
		'Segmenting source in page windows',
	);

	for (const window of windows) {
		const previousWindowContext = buildPreviousWindowContext(mergeWindowStories(windowedStories), window);
		const renderedPrompt = buildWindowPrompt(basePrompt, layoutDoc, window, previousWindowContext);
		const media = sendPageImages
			? selectWindowMedia(window, pageImageMap, segmentationConfig.max_media_pages_per_window)
			: [];

		try {
			const segmentationResponse = await services.llm.generateStructured<SegmentationResponse>({
				prompt: renderedPrompt,
				schema: getSegmentationJsonSchema(),
				media: media.length > 0 ? media : undefined,
				responseValidator: (data) => segmentationResponseSchema.parse(data),
			});

			for (const rawStory of segmentationResponse.stories) {
				const story = clampStoryToDocument(rawStory, layoutDoc.pageCount);
				if (story) {
					windowedStories.push(story);
				}
			}

			log.debug(
				{
					window: window.index + 1,
					pageStart: window.pageStart,
					pageEnd: window.pageEnd,
					storyCount: segmentationResponse.stories.length,
					mediaCount: media.length,
				},
				'Segment window completed',
			);
		} catch (cause: unknown) {
			const causeDetails = describeSegmentCause(cause);
			const pageRange = `${window.pageStart}-${window.pageEnd}`;
			const message = `Vertex structured generation failed for pages ${pageRange}: ${causeDetails.message}`;
			errors.push({
				file: `pages ${pageRange}`,
				code: SEGMENT_ERROR_CODES.SEGMENT_LLM_FAILED,
				message,
			});
			log.warn(
				{
					err: cause,
					window: window.index + 1,
					pageStart: window.pageStart,
					pageEnd: window.pageEnd,
					errorName: causeDetails.name,
					errorCode: causeDetails.code,
					errorStatus: causeDetails.status,
					retryable: causeDetails.retryable,
					windowIndex: window.index + 1,
				},
				'Segment window failed',
			);
		}
	}

	// 8. Handle zero or missing stories
	const stories = mergeWindowStories(windowedStories);
	if (!Array.isArray(stories) || stories.length === 0) {
		const durationMs = Math.round(performance.now() - startTime);
		log.warn(
			{ sourceId: input.sourceId, errors: errors.length },
			'Gemini returned zero stories — not updating source status',
		);
		const stepErrors =
			errors.length > 0
				? errors
				: [
						{
							code: SEGMENT_ERROR_CODES.SEGMENT_NO_STORIES_FOUND,
							message: `No stories identified in source ${input.sourceId}`,
						},
					];
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: 'failed',
			configHash: stepConfigHash,
			errorMessage: stepErrors[0]?.message,
		});
		return {
			status: 'failed',
			data: null,
			errors: stepErrors,
			metadata: {
				duration_ms: durationMs,
				items_processed: 0,
				items_skipped: layoutDoc.pageCount,
				items_cached: 0,
			},
		};
	}

	// 9. Process each identified story
	const segmentedStories: SegmentedStory[] = [];
	const latestQuality = config.document_quality.enabled
		? await findLatestDocumentQualityAssessment(pool, input.sourceId)
		: null;
	const qualitySummary =
		latestQuality && config.document_quality.quality_propagation.enabled
			? buildCompactDocumentQualitySummary(latestQuality)
			: null;

	for (const story of stories) {
		const storyId = randomUUID();

		// Build metadata JSON
		const metadata = buildSegmentMetadata(storyId, input.sourceId, source.sourceType, story);

		const markdownUri = `segments/${input.sourceId}/${storyId}.md`;
		const metadataUri = `segments/${input.sourceId}/${storyId}.meta.json`;

		// Write Markdown to GCS
		try {
			await services.storage.upload(markdownUri, story.content_markdown, 'text/markdown');
		} catch (cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			errors.push({
				code: SEGMENT_ERROR_CODES.SEGMENT_STORAGE_FAILED,
				message: `Failed to write Markdown for story "${story.title}": ${message}`,
			});
			log.warn({ storyId, err: cause }, 'Failed to write story Markdown — skipping');
			continue;
		}

		// Write metadata JSON to GCS
		try {
			await services.storage.upload(metadataUri, JSON.stringify(metadata, null, 2), 'application/json');
		} catch (cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			errors.push({
				code: SEGMENT_ERROR_CODES.SEGMENT_STORAGE_FAILED,
				message: `Failed to write metadata for story "${story.title}": ${message}`,
			});
			log.warn({ storyId, err: cause }, 'Failed to write story metadata — skipping');
			continue;
		}

		// Create story record in PostgreSQL — pass the same UUID used for GCS paths
		await createStory(pool, {
			id: storyId,
			sourceId: input.sourceId,
			title: story.title,
			subtitle: story.subtitle ?? undefined,
			language: story.language,
			category: story.category,
			pageStart: story.page_start,
			pageEnd: story.page_end,
			gcsMarkdownUri: markdownUri,
			gcsMetadataUri: metadataUri,
			extractionConfidence: story.confidence,
			metadata: mergeQualitySummary(
				{
					source_type: source.sourceType,
					dateReferences: story.date_references,
					geographicReferences: story.geographic_references,
				},
				qualitySummary,
			),
		});

		segmentedStories.push({
			id: storyId,
			title: story.title,
			subtitle: story.subtitle,
			language: story.language,
			category: story.category,
			pageStart: story.page_start,
			pageEnd: story.page_end,
			dateReferences: story.date_references,
			geographicReferences: story.geographic_references,
			extractionConfidence: story.confidence,
			gcsMarkdownUri: markdownUri,
			gcsMetadataUri: metadataUri,
		});

		log.debug(
			{
				storyId,
				title: story.title,
				pages: `${story.page_start}-${story.page_end}`,
				language: story.language,
				confidence: story.confidence,
			},
			'Story segmented and stored',
		);
	}

	// 10. Determine overall status BEFORE updating database
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (segmentedStories.length > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	// 11. Update database — only mark as segmented/completed when stories were persisted
	if (status !== 'failed') {
		await updateSourceStatus(pool, input.sourceId, 'segmented');
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: status === 'partial' ? 'partial' : 'completed',
			configHash: stepConfigHash,
			errorMessage: status === 'partial' ? errors[0]?.message : undefined,
		});
	} else {
		// All stories failed GCS upload — leave source at 'extracted', mark step as failed
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: 'failed',
			configHash: stepConfigHash,
			errorMessage: errors[0]?.message,
		});
	}

	// 12. Firestore observability (fire-and-forget)
	services.firestore
		.setDocument('documents', input.sourceId, {
			status: status !== 'failed' ? 'segmented' : 'failed',
			segmentedAt: new Date().toISOString(),
			storyCount: segmentedStories.length,
		})
		.catch(() => {
			// Silently swallow — Firestore is best-effort observability
		});

	const durationMs = Math.round(performance.now() - startTime);
	const segmentationData: SegmentationData = {
		sourceId: input.sourceId,
		storyCount: segmentedStories.length,
		stories: segmentedStories,
	};

	log.info(
		{
			status,
			storyCount: segmentedStories.length,
			pageCount: layoutDoc.pageCount,
			errors: errors.length,
			duration_ms: durationMs,
		},
		'Segment step completed',
	);

	return {
		status,
		data: segmentationData,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: segmentedStories.length,
			items_skipped: layoutDoc.pageCount - segmentedStories.length,
			items_cached: 0,
		},
	};
}
