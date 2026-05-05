/**
 * Job dispatch layer for the worker runtime.
 *
 * Validates payloads and maps queue job types to the corresponding pipeline
 * or taxonomy execution function.
 *
 * @see docs/specs/68_worker_loop.spec.md §4.1
 * @see docs/functional-spec.md §10.2, §10.4
 */

import { createHash } from 'node:crypto';
import type { MulderConfig, Services, SourceFormatMetadata, SourceType } from '@mulder/core';
import {
	buildContentAddressedBlobPath,
	createChildLogger,
	createPipelineRun,
	createSource,
	detectNativeText,
	enqueueJob,
	extractPdfMetadata,
	findDocumentBlobByHash,
	findSourceByCrossFormatDedupKey,
	findSourceByHash,
	findSourceById,
	findStoriesBySourceId,
	INGEST_ERROR_CODES,
	IngestError,
	upsertDocumentBlob,
	upsertPipelineRunSource,
	upsertSourceStep,
} from '@mulder/core';
import {
	buildDocxFormatMetadata,
	buildEmailFormatMetadata,
	buildImageFormatMetadata,
	buildSpreadsheetFormatMetadata,
	buildTabularCrossFormatContent,
	buildTextFormatMetadata,
	CSV_MEDIA_TYPE,
	decodeUtf8TextBuffer,
	deriveMarkdownTitle,
	detectSourceType,
	executeEmbed,
	executeEnrich,
	executeExtract,
	executeGraph,
	executePipelineRun,
	executeSegment,
	getCrossFormatDedupKey,
	getStorageExtensionForDetection,
	isSupportedEmailMediaType,
	isSupportedImageMediaType,
	isSupportedSpreadsheetMediaType,
	isSupportedTextFilename,
	isSupportedTextMediaType,
	type PipelineRunOptions,
	withCrossFormatDedupMetadata,
} from '@mulder/pipeline';
import type pg from 'pg';
import {
	type DocumentUploadFinalizeJobPayload,
	type StoryStepJobPayload,
	type SupportedJobType,
	WORKER_ERROR_CODES,
	type WorkerDispatchFn,
	WorkerError,
	type WorkerJobEnvelope,
} from './worker.types.js';

export interface DispatchResult {
	jobType: SupportedJobType;
}

export type DispatchResultKind = DispatchResult['jobType'];

function assertStepSucceeded(job: WorkerJobEnvelope, stepName: string, status: string): void {
	if (status === 'success') {
		return;
	}

	throw new WorkerError(
		`${stepName} job ${job.id} finished with status ${status}`,
		WORKER_ERROR_CODES.WORKER_LOOP_FAILED,
		{ context: { jobId: job.id, jobType: job.type, status } },
	);
}

function assertPipelineRunCompleted(job: WorkerJobEnvelope, status: string): void {
	if (status === 'success' || status === 'partial') {
		return;
	}

	throw new WorkerError(
		`pipeline_run job ${job.id} finished with status ${status}`,
		WORKER_ERROR_CODES.WORKER_LOOP_FAILED,
		{
			context: { jobId: job.id, jobType: job.type, status },
		},
	);
}

const BROWSER_UPLOAD_PIPELINE_TAG = 'browser-upload';

function isProvisionalRawUploadPath(storagePath: string): boolean {
	return /^raw\/[^/]+\/original\.[a-z0-9][a-z0-9-]*$/u.test(storagePath);
}

function buildPdfMetadataJson(pdfMeta: Awaited<ReturnType<typeof extractPdfMetadata>>): Record<string, unknown> {
	const pdfMetadataJson: Record<string, unknown> = {};
	if (pdfMeta.pdfVersion) pdfMetadataJson.pdf_version = pdfMeta.pdfVersion;
	if (pdfMeta.title) pdfMetadataJson.title = pdfMeta.title;
	if (pdfMeta.author) pdfMetadataJson.author = pdfMeta.author;
	if (pdfMeta.creator) pdfMetadataJson.creator = pdfMeta.creator;
	if (pdfMeta.producer) pdfMetadataJson.producer = pdfMeta.producer;
	if (pdfMeta.creationDate) pdfMetadataJson.creation_date = pdfMeta.creationDate.toISOString();
	if (pdfMeta.modificationDate) pdfMetadataJson.modification_date = pdfMeta.modificationDate.toISOString();
	if (pdfMeta.encrypted !== undefined) pdfMetadataJson.encrypted = pdfMeta.encrypted;
	return pdfMetadataJson;
}

type FinalizableSourceType = Extract<SourceType, 'pdf' | 'image' | 'text' | 'docx' | 'spreadsheet' | 'email'>;

interface FinalizedUploadMetadata {
	sourceType: FinalizableSourceType;
	formatMetadata: SourceFormatMetadata;
	pageCount: number;
	hasNativeText: boolean;
	nativeTextRatio: number;
	mediaType: string;
	storageExtension: string;
}

function isFinalizableSourceType(sourceType: SourceType): sourceType is FinalizableSourceType {
	return (
		sourceType === 'pdf' ||
		sourceType === 'image' ||
		sourceType === 'text' ||
		sourceType === 'docx' ||
		sourceType === 'spreadsheet' ||
		sourceType === 'email'
	);
}

async function ensureFinalizedUploadBlob(input: {
	services: Services;
	pool: pg.Pool;
	contentHash: string;
	content: Buffer;
	mediaType: string;
	storageExtension: string;
	filename: string;
}): Promise<string> {
	const existingBlob = await findDocumentBlobByHash(input.pool, input.contentHash);
	if (existingBlob) {
		await upsertDocumentBlob(input.pool, {
			contentHash: input.contentHash,
			storagePath: existingBlob.storagePath,
			storageUri: existingBlob.storageUri,
			mimeType: existingBlob.mimeType,
			fileSizeBytes: existingBlob.fileSizeBytes,
			originalFilenames: [input.filename],
		});
		return existingBlob.storagePath;
	}

	const storagePath = buildContentAddressedBlobPath(input.contentHash, input.storageExtension);
	const exists = await input.services.storage.exists(storagePath);
	let uploadedAlternate = false;
	if (!exists) {
		await input.services.storage.upload(storagePath, input.content, input.mediaType);
		uploadedAlternate = true;
	}

	const blob = await upsertDocumentBlob(input.pool, {
		contentHash: input.contentHash,
		storagePath,
		storageUri: input.services.storage.buildUri(storagePath),
		mimeType: input.mediaType,
		fileSizeBytes: input.content.byteLength,
		originalFilenames: [input.filename],
	});

	if (uploadedAlternate && blob.storagePath !== storagePath) {
		await input.services.storage.delete(storagePath);
	}

	return blob.storagePath;
}

async function runStoryStepForPayload(
	jobType: 'enrich' | 'embed' | 'graph',
	payload: StoryStepJobPayload,
	context: {
		config: MulderConfig;
		services: Services;
		pool: import('pg').Pool;
		log: ReturnType<typeof createChildLogger>;
	},
): Promise<{ status: 'success'; story_count: number }> {
	const { config, services, pool, log } = context;
	const force = payload.force ?? false;

	if (payload.storyId) {
		if (jobType === 'enrich') {
			await executeEnrich(
				{ storyId: payload.storyId, force, extractionPipelineRun: payload.runId ?? null },
				config,
				services,
				pool,
				log,
			);
		} else if (jobType === 'embed') {
			await executeEmbed(
				{ storyId: payload.storyId, force, extractionPipelineRun: payload.runId ?? null },
				config,
				services,
				pool,
				log,
			);
		} else {
			await executeGraph(
				{ storyId: payload.storyId, force, extractionPipelineRun: payload.runId ?? null },
				config,
				services,
				pool,
				log,
			);
		}
		return { status: 'success', story_count: 1 };
	}

	if (!payload.sourceId) {
		throw new WorkerError(
			`${jobType} jobs require a storyId or sourceId after validation`,
			WORKER_ERROR_CODES.WORKER_INVALID_JOB_PAYLOAD,
		);
	}

	const stories = await findStoriesBySourceId(pool, payload.sourceId);
	let processed = 0;
	for (const story of stories) {
		if (jobType === 'enrich') {
			await executeEnrich(
				{ storyId: story.id, force, extractionPipelineRun: payload.runId ?? null },
				config,
				services,
				pool,
				log,
			);
		} else if (jobType === 'embed') {
			await executeEmbed(
				{ storyId: story.id, force, extractionPipelineRun: payload.runId ?? null },
				config,
				services,
				pool,
				log,
			);
		} else {
			await executeGraph(
				{ storyId: story.id, force, extractionPipelineRun: payload.runId ?? null },
				config,
				services,
				pool,
				log,
			);
		}
		processed++;
	}

	return { status: 'success', story_count: processed };
}

async function finalizeUploadedDocument(
	context: {
		config: MulderConfig;
		services: Services;
		pool: import('pg').Pool;
		log: ReturnType<typeof createChildLogger>;
	},
	payload: DocumentUploadFinalizeJobPayload,
): Promise<Record<string, unknown>> {
	const { config, services, pool, log } = context;

	const existingSource = await findSourceById(pool, payload.sourceId);
	if (existingSource) {
		if (payload.storagePath !== existingSource.storagePath && isProvisionalRawUploadPath(payload.storagePath)) {
			await services.storage.delete(payload.storagePath);
		}
		return {
			result_status: 'created',
			resolved_source_id: existingSource.id,
		};
	}

	const metadata = await services.storage.getMetadata(payload.storagePath);
	if (!metadata) {
		throw new IngestError(
			`Uploaded object not found: ${payload.storagePath}`,
			INGEST_ERROR_CODES.INGEST_FILE_NOT_FOUND,
			{
				context: { storagePath: payload.storagePath, sourceId: payload.sourceId },
			},
		);
	}

	const maxSizeBytes = config.ingestion.max_file_size_mb * 1024 * 1024;
	if (metadata.sizeBytes > maxSizeBytes) {
		throw new IngestError(
			`Uploaded file exceeds configured ingest limit: ${payload.filename}`,
			INGEST_ERROR_CODES.INGEST_FILE_TOO_LARGE,
			{
				context: {
					storagePath: payload.storagePath,
					sourceId: payload.sourceId,
					fileSizeBytes: metadata.sizeBytes,
					maxBytes: maxSizeBytes,
				},
			},
		);
	}

	const buffer = await services.storage.download(payload.storagePath);
	const detection = detectSourceType(buffer, payload.filename);
	if (!detection) {
		throw new IngestError(
			`Unsupported or unknown source format for ${payload.filename}`,
			INGEST_ERROR_CODES.INGEST_UNKNOWN_SOURCE_TYPE,
			{
				context: { storagePath: payload.storagePath, sourceId: payload.sourceId },
			},
		);
	}
	if (!isFinalizableSourceType(detection.sourceType)) {
		throw new IngestError(
			`Unsupported source type "${detection.sourceType}" for ${payload.filename}; only pdf, image, text, docx, spreadsheet, and email are supported in this step`,
			INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
			{
				context: {
					storagePath: payload.storagePath,
					sourceId: payload.sourceId,
					sourceType: detection.sourceType,
					confidence: detection.confidence,
				},
			},
		);
	}
	const canonicalStorageExtension = getStorageExtensionForDetection(detection);
	if (!canonicalStorageExtension || !detection.mediaType) {
		throw new IngestError(
			`Unsupported or unknown source format for ${payload.filename}`,
			INGEST_ERROR_CODES.INGEST_UNKNOWN_SOURCE_TYPE,
			{
				context: {
					storagePath: payload.storagePath,
					sourceId: payload.sourceId,
					sourceType: detection.sourceType,
					mediaType: detection.mediaType,
				},
			},
		);
	}

	const fileHash = createHash('sha256').update(buffer).digest('hex');
	const duplicateSource = await findSourceByHash(pool, fileHash);
	if (duplicateSource && duplicateSource.id !== payload.sourceId) {
		const duplicateStorageExtension = getStorageExtensionForDetection(detection);
		if (duplicateStorageExtension && detection.mediaType) {
			await ensureFinalizedUploadBlob({
				services,
				pool,
				contentHash: fileHash,
				content: buffer,
				mediaType: detection.mediaType,
				storageExtension: duplicateStorageExtension,
				filename: payload.filename,
			});
		}
		await services.storage.delete(payload.storagePath);
		return {
			result_status: 'duplicate',
			resolved_source_id: duplicateSource.id,
			duplicate_of_source_id: duplicateSource.id,
		};
	}

	let finalizedMetadata: FinalizedUploadMetadata;
	if (detection.sourceType === 'pdf') {
		const pdfMeta = await extractPdfMetadata(buffer);
		if (pdfMeta.pageCount > config.ingestion.max_pages) {
			throw new IngestError(
				`Uploaded file exceeds configured page limit: ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_TOO_MANY_PAGES,
				{
					context: {
						storagePath: payload.storagePath,
						sourceId: payload.sourceId,
						pageCount: pdfMeta.pageCount,
						maxPages: config.ingestion.max_pages,
					},
				},
			);
		}

		const textResult = await detectNativeText(buffer);
		finalizedMetadata = {
			sourceType: 'pdf',
			formatMetadata: buildPdfMetadataJson(pdfMeta),
			pageCount: textResult.pageCount,
			hasNativeText: textResult.hasNativeText,
			nativeTextRatio: textResult.nativeTextRatio,
			mediaType: detection.mediaType,
			storageExtension: canonicalStorageExtension,
		};
	} else if (detection.sourceType === 'image') {
		if (!isSupportedImageMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported image media type for ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { storagePath: payload.storagePath, sourceId: payload.sourceId, mediaType: detection.mediaType },
				},
			);
		}
		finalizedMetadata = {
			sourceType: 'image',
			formatMetadata: buildImageFormatMetadata(buffer, payload.filename, detection.mediaType),
			pageCount: 1,
			hasNativeText: false,
			nativeTextRatio: 0,
			mediaType: detection.mediaType,
			storageExtension: canonicalStorageExtension,
		};
	} else if (detection.sourceType === 'text') {
		if (!isSupportedTextFilename(payload.filename)) {
			throw new IngestError(
				`Unsupported text source extension for ${payload.filename}; supported text files must end with .txt, .md, or .markdown`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: {
						storagePath: payload.storagePath,
						sourceId: payload.sourceId,
						sourceType: detection.sourceType,
						confidence: detection.confidence,
					},
				},
			);
		}

		if (!isSupportedTextMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported text media type for ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { storagePath: payload.storagePath, sourceId: payload.sourceId, mediaType: detection.mediaType },
				},
			);
		}

		const textContent = decodeUtf8TextBuffer(buffer);
		const formatMetadata = buildTextFormatMetadata(buffer, payload.filename, detection.mediaType);
		if (!formatMetadata) {
			throw new IngestError(
				`Text source is not readable UTF-8: ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { storagePath: payload.storagePath, sourceId: payload.sourceId, mediaType: detection.mediaType },
				},
			);
		}

		finalizedMetadata = {
			sourceType: 'text',
			formatMetadata: withCrossFormatDedupMetadata(formatMetadata, {
				content: textContent,
				title: textContent ? deriveMarkdownTitle(textContent) : null,
				basis: 'text_content',
			}),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
			mediaType: typeof formatMetadata.media_type === 'string' ? formatMetadata.media_type : detection.mediaType,
			storageExtension: canonicalStorageExtension,
		};
	} else if (detection.sourceType === 'docx') {
		finalizedMetadata = {
			sourceType: 'docx',
			formatMetadata: buildDocxFormatMetadata(buffer, payload.filename),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
			mediaType: detection.mediaType,
			storageExtension: canonicalStorageExtension,
		};
	} else if (detection.sourceType === 'spreadsheet') {
		if (!isSupportedSpreadsheetMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported spreadsheet media type for ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { storagePath: payload.storagePath, sourceId: payload.sourceId, mediaType: detection.mediaType },
				},
			);
		}

		let extractionResult: Awaited<ReturnType<Services['spreadsheets']['extractSpreadsheet']>>;
		try {
			extractionResult = await services.spreadsheets.extractSpreadsheet(
				buffer,
				payload.sourceId,
				detection.mediaType === CSV_MEDIA_TYPE ? 'csv' : 'xlsx',
			);
		} catch (cause: unknown) {
			throw new IngestError(
				`Invalid spreadsheet upload: ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					cause,
					context: { storagePath: payload.storagePath, sourceId: payload.sourceId, mediaType: detection.mediaType },
				},
			);
		}

		finalizedMetadata = {
			sourceType: 'spreadsheet',
			formatMetadata: withCrossFormatDedupMetadata(
				buildSpreadsheetFormatMetadata(buffer, payload.filename, detection.mediaType, extractionResult),
				{
					content: buildTabularCrossFormatContent(extractionResult.sheets),
					basis: 'tabular_rows',
				},
			),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
			mediaType: detection.mediaType,
			storageExtension: canonicalStorageExtension,
		};
	} else {
		if (!isSupportedEmailMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported email media type for ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { storagePath: payload.storagePath, sourceId: payload.sourceId, mediaType: detection.mediaType },
				},
			);
		}

		let extractionResult: Awaited<ReturnType<Services['emails']['extractEmail']>>;
		try {
			extractionResult = await services.emails.extractEmail(
				buffer,
				payload.sourceId,
				detection.mediaType === 'message/rfc822' ? 'eml' : 'msg',
			);
		} catch (cause: unknown) {
			throw new IngestError(
				`Invalid email upload: ${payload.filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					cause,
					context: { storagePath: payload.storagePath, sourceId: payload.sourceId, mediaType: detection.mediaType },
				},
			);
		}

		finalizedMetadata = {
			sourceType: 'email',
			formatMetadata: withCrossFormatDedupMetadata(
				buildEmailFormatMetadata(buffer, payload.filename, detection.mediaType, extractionResult),
				{
					content: [extractionResult.headers.subject, extractionResult.bodyText || extractionResult.bodyHtmlText]
						.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
						.join('\n\n'),
					title: extractionResult.headers.subject,
					basis: 'email_body',
				},
			),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
			mediaType: detection.mediaType,
			storageExtension: canonicalStorageExtension,
		};
	}

	const crossFormatDedupKey = getCrossFormatDedupKey(finalizedMetadata.formatMetadata);
	if (crossFormatDedupKey) {
		const existingCrossFormatSource = await findSourceByCrossFormatDedupKey(pool, crossFormatDedupKey);
		if (existingCrossFormatSource && existingCrossFormatSource.id !== payload.sourceId) {
			await services.storage.delete(payload.storagePath);
			log.info(
				{ sourceId: existingCrossFormatSource.id, crossFormatDedupKey },
				'Cross-format duplicate upload detected, skipping source creation',
			);
			return {
				result_status: 'duplicate',
				resolved_source_id: existingCrossFormatSource.id,
				duplicate_of_source_id: existingCrossFormatSource.id,
			};
		}
	}

	const finalizedStoragePath = await ensureFinalizedUploadBlob({
		services,
		pool,
		contentHash: fileHash,
		content: buffer,
		mediaType: finalizedMetadata.mediaType,
		storageExtension: finalizedMetadata.storageExtension,
		filename: payload.filename,
	});
	const shouldCleanupOriginalUpload = payload.storagePath !== finalizedStoragePath;

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const source = await createSource(client, {
			id: payload.sourceId,
			filename: payload.filename,
			storagePath: finalizedStoragePath,
			fileHash,
			pageCount: finalizedMetadata.pageCount,
			hasNativeText: finalizedMetadata.hasNativeText,
			nativeTextRatio: finalizedMetadata.nativeTextRatio,
			tags: payload.tags,
			sourceType: finalizedMetadata.sourceType,
			formatMetadata: finalizedMetadata.formatMetadata,
			metadata: finalizedMetadata.formatMetadata,
		});

		if (source.id !== payload.sourceId) {
			await client.query('ROLLBACK');
			if (shouldCleanupOriginalUpload) {
				await services.storage.delete(payload.storagePath);
			}
			return {
				result_status: 'duplicate',
				resolved_source_id: source.id,
				duplicate_of_source_id: source.id,
			};
		}

		await upsertSourceStep(client, {
			sourceId: source.id,
			stepName: 'ingest',
			status: 'completed',
		});

		const completionPayload: Record<string, unknown> = {
			result_status: 'created',
			resolved_source_id: source.id,
		};

		if (payload.startPipeline ?? true) {
			const run = await createPipelineRun(client, {
				tag: BROWSER_UPLOAD_PIPELINE_TAG,
				options: {
					source_id: source.id,
					from: 'extract',
					up_to: null,
					force: false,
				},
			});
			const pipelineJob = await enqueueJob(client, {
				type: 'extract',
				payload: {
					sourceId: source.id,
					runId: run.id,
					upTo: 'graph',
					force: false,
					tag: BROWSER_UPLOAD_PIPELINE_TAG,
				},
				maxAttempts: 3,
			});
			await upsertPipelineRunSource(client, {
				runId: run.id,
				sourceId: source.id,
				currentStep: 'ingest',
				status: 'pending',
			});
			completionPayload.pipeline_job_id = pipelineJob.id;
			completionPayload.pipeline_run_id = run.id;
		}

		await client.query('COMMIT');

		services.firestore
			.setDocument('documents', source.id, {
				filename: payload.filename,
				uploadedAt: new Date().toISOString(),
				fileHash,
				sourceType: source.sourceType,
				status: 'ingested',
			})
			.catch(() => {
				// Observability projection remains best-effort.
			});

		if (shouldCleanupOriginalUpload) {
			await services.storage.delete(payload.storagePath);
		}

		log.info({ sourceId: source.id, storagePath: finalizedStoragePath }, 'Browser upload finalized');
		return completionPayload;
	} catch (error) {
		try {
			await client.query('ROLLBACK');
		} catch {
			// Ignore rollback failures and surface the original error.
		}
		throw error;
	} finally {
		client.release();
	}
}

export const dispatchJob: WorkerDispatchFn = async (job, context) => {
	const log = createChildLogger(context.logger, { jobId: job.id, jobType: job.type });
	const config: MulderConfig = context.config;
	const services: Services = context.services;
	const pool = context.pool;

	switch (job.type) {
		case 'extract': {
			const result = await executeExtract(job.payload, config, services, pool, log);
			assertStepSucceeded(job, 'extract', result.status);
			return;
		}
		case 'segment': {
			const result = await executeSegment(job.payload, config, services, pool, log);
			assertStepSucceeded(job, 'segment', result.status);
			return;
		}
		case 'enrich': {
			const result = await runStoryStepForPayload('enrich', job.payload, { config, services, pool, log });
			assertStepSucceeded(job, 'enrich', result.status);
			return;
		}
		case 'embed': {
			const result = await runStoryStepForPayload('embed', job.payload, { config, services, pool, log });
			assertStepSucceeded(job, 'embed', result.status);
			return;
		}
		case 'graph': {
			const result = await runStoryStepForPayload('graph', job.payload, { config, services, pool, log });
			assertStepSucceeded(job, 'graph', result.status);
			return;
		}
		case 'document_upload_finalize': {
			return await finalizeUploadedDocument({ config, services, pool, log }, job.payload);
		}
		case 'pipeline_run': {
			const runOptions: PipelineRunOptions = {
				sourceIds: [job.payload.sourceId],
				force: job.payload.force ?? false,
			};
			if (job.payload.runId) {
				runOptions.runId = job.payload.runId;
			}
			if (job.payload.from) {
				runOptions.from = job.payload.from;
			}
			if (job.payload.upTo) {
				runOptions.upTo = job.payload.upTo;
			}
			if (job.payload.tag) {
				runOptions.tag = job.payload.tag;
			}
			const result = await executePipelineRun({ options: runOptions }, config, services, pool, log);
			assertPipelineRunCompleted(job, result.status);
			return;
		}
	}
};
