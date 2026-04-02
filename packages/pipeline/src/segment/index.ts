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
import type { Logger, MulderConfig, Services, StepError } from '@mulder/core';
import {
	createChildLogger,
	createStory,
	deleteSourceStep,
	deleteStoriesBySourceId,
	findSourceById,
	renderPrompt,
	SEGMENT_ERROR_CODES,
	SegmentError,
	updateSourceStatus,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import type { LayoutDocument, LayoutPage } from '../extract/types.js';
import { getSegmentationJsonSchema, segmentationResponseSchema } from './schema.js';
import type { SegmentationData, SegmentedStory, SegmentInput, SegmentResult } from './types.js';

export type { SegmentationData, SegmentedStory, SegmentInput, SegmentResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STEP_NAME = 'segment';

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing segmentation artifacts before re-segmentation.
 * Deletes all stories for the source (cascade-deletes chunks, edges),
 * GCS segment prefix, and the source step record.
 */
async function forceCleanup(sourceId: string, services: Services, pool: pg.Pool, logger: Logger): Promise<void> {
	// 1. Delete story records (PostgreSQL cascading handles chunks, story_entities, edges)
	const deletedCount = await deleteStoriesBySourceId(pool, sourceId);
	logger.debug({ sourceId, deletedStories: deletedCount }, 'Deleted existing stories for source');

	// 2. Delete GCS segment artifacts
	const prefix = `segments/${sourceId}/`;
	const existing = await services.storage.list(prefix);
	for (const path of existing.paths) {
		await services.storage.delete(path);
	}
	logger.debug({ sourceId, deletedFiles: existing.paths.length }, 'Deleted existing segment artifacts');

	// 3. Delete the segment source step so it re-tracks as new
	await deleteSourceStep(pool, sourceId, STEP_NAME);

	// 4. Update source status back to extracted
	await updateSourceStatus(pool, sourceId, 'extracted');
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

// ────────────────────────────────────────────────────────────
// Segment metadata JSON builder
// ────────────────────────────────────────────────────────────

interface SegmentMetadataJson {
	id: string;
	document_id: string;
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

	// 5. Load page images from GCS
	const pageImages = await loadPageImages(input.sourceId, layoutDoc.pages, services, log);

	// 6. Build segmentation prompt
	const locale = config.project.supported_locales[0] ?? 'en';

	// Render the base template (page_content is appended separately since
	// the template engine uses simple placeholder interpolation, not Jinja2 for-loops)
	const basePrompt = renderPrompt('segment', {
		locale,
		page_count: String(layoutDoc.pageCount),
		has_native_text: String(layoutDoc.primaryMethod === 'native'),
	});

	// Append page content from layout JSON
	const pageContentLines: string[] = ['', '## Page Content'];
	for (const page of layoutDoc.pages) {
		pageContentLines.push(`### Page ${page.pageNumber}`);
		pageContentLines.push(page.text);
		pageContentLines.push('');
	}

	const renderedPrompt = basePrompt + pageContentLines.join('\n');

	// 7. Call Gemini structured output
	const errors: StepError[] = [];
	let segmentationResponse: {
		stories: Array<{
			title: string;
			subtitle: string | null;
			language: string;
			category: string;
			page_start: number;
			page_end: number;
			date_references: string[];
			geographic_references: string[];
			confidence: number;
			content_markdown: string;
		}>;
	};

	try {
		// Prepare media: non-empty page images
		const media: Array<{ mimeType: string; data: Buffer }> = [];
		for (const img of pageImages) {
			if (img.length > 0) {
				media.push({ mimeType: 'image/png', data: img });
			}
		}

		segmentationResponse = await services.llm.generateStructured({
			prompt: renderedPrompt,
			schema: getSegmentationJsonSchema(),
			media: media.length > 0 ? media : undefined,
			responseValidator: (data) => segmentationResponseSchema.parse(data),
		});
	} catch (cause: unknown) {
		throw new SegmentError(
			`Gemini segmentation failed for source ${input.sourceId}`,
			SEGMENT_ERROR_CODES.SEGMENT_LLM_FAILED,
			{ cause, context: { sourceId: input.sourceId } },
		);
	}

	// 8. Handle zero or missing stories
	const stories = segmentationResponse.stories;
	if (!Array.isArray(stories) || stories.length === 0) {
		const durationMs = Math.round(performance.now() - startTime);
		log.warn({ sourceId: input.sourceId }, 'Gemini returned zero stories — not updating source status');
		return {
			status: 'failed',
			data: null,
			errors: [
				{
					code: SEGMENT_ERROR_CODES.SEGMENT_NO_STORIES_FOUND,
					message: `No stories identified in source ${input.sourceId}`,
				},
			],
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

	for (const story of stories) {
		const storyId = randomUUID();

		// Build metadata JSON
		const metadata = buildSegmentMetadata(storyId, input.sourceId, story);

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
			metadata: {
				dateReferences: story.date_references,
				geographicReferences: story.geographic_references,
			},
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
			status: 'completed',
		});
	} else {
		// All stories failed GCS upload — leave source at 'extracted', mark step as failed
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: 'failed',
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
