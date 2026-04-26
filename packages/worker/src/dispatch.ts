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
import type { MulderConfig, Services } from '@mulder/core';
import {
	createChildLogger,
	createPipelineRun,
	createSource,
	detectNativeText,
	enqueueJob,
	extractPdfMetadata,
	findSourceByHash,
	findSourceById,
	findStoriesBySourceId,
	INGEST_ERROR_CODES,
	IngestError,
	upsertPipelineRunSource,
	upsertSourceStep,
} from '@mulder/core';
import {
	executeEmbed,
	executeEnrich,
	executeExtract,
	executeGraph,
	executePipelineRun,
	executeSegment,
	type PipelineRunOptions,
} from '@mulder/pipeline';
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

const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const BROWSER_UPLOAD_PIPELINE_TAG = 'browser-upload';

function hasPdfMagicBytes(buffer: Buffer): boolean {
	return buffer.length >= PDF_MAGIC_BYTES.length && buffer.subarray(0, PDF_MAGIC_BYTES.length).equals(PDF_MAGIC_BYTES);
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
			await executeEnrich({ storyId: payload.storyId, force }, config, services, pool, log);
		} else if (jobType === 'embed') {
			await executeEmbed({ storyId: payload.storyId, force }, config, services, pool, log);
		} else {
			await executeGraph({ storyId: payload.storyId, force }, config, services, pool, log);
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
			await executeEnrich({ storyId: story.id, force }, config, services, pool, log);
		} else if (jobType === 'embed') {
			await executeEmbed({ storyId: story.id, force }, config, services, pool, log);
		} else {
			await executeGraph({ storyId: story.id, force }, config, services, pool, log);
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
	if (!hasPdfMagicBytes(buffer)) {
		throw new IngestError(`Not a valid PDF file: ${payload.filename}`, INGEST_ERROR_CODES.INGEST_NOT_PDF, {
			context: { storagePath: payload.storagePath, sourceId: payload.sourceId },
		});
	}

	const fileHash = createHash('sha256').update(buffer).digest('hex');
	const duplicateSource = await findSourceByHash(pool, fileHash);
	if (duplicateSource && duplicateSource.id !== payload.sourceId) {
		await services.storage.delete(payload.storagePath);
		return {
			result_status: 'duplicate',
			resolved_source_id: duplicateSource.id,
			duplicate_of_source_id: duplicateSource.id,
		};
	}

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

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const source = await createSource(client, {
			id: payload.sourceId,
			filename: payload.filename,
			storagePath: payload.storagePath,
			fileHash,
			pageCount: textResult.pageCount,
			hasNativeText: textResult.hasNativeText,
			nativeTextRatio: textResult.nativeTextRatio,
			tags: payload.tags,
			metadata: buildPdfMetadataJson(pdfMeta),
		});

		if (source.id !== payload.sourceId) {
			await client.query('ROLLBACK');
			await services.storage.delete(payload.storagePath);
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
				status: 'ingested',
			})
			.catch(() => {
				// Observability projection remains best-effort.
			});

		log.info({ sourceId: source.id, storagePath: payload.storagePath }, 'Browser upload finalized');
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
