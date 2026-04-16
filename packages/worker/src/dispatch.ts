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
	INGEST_ERROR_CODES,
	IngestError,
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
	type PipelineStepName,
} from '@mulder/pipeline';
import {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function readStringField(job: WorkerJobEnvelope, primaryKey: string, fallbackKey?: string): string | null {
	if (isRecord(job.payload)) {
		const primary = asString(job.payload[primaryKey]);
		if (primary) {
			return primary;
		}
		if (fallbackKey) {
			return asString(job.payload[fallbackKey]);
		}
	}
	return null;
}

function invalidPayload(job: WorkerJobEnvelope, reason: string, context?: Record<string, unknown>): WorkerError {
	return new WorkerError(reason, WORKER_ERROR_CODES.WORKER_INVALID_JOB_PAYLOAD, {
		context: { jobId: job.id, jobType: job.type, ...(context ?? {}) },
	});
}

function parseSourceStepPayload(job: WorkerJobEnvelope): {
	sourceId: string;
	force?: boolean;
	fallbackOnly?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(job, 'sourceId', 'source_id');
	if (!sourceId) {
		throw invalidPayload(job, `${job.type} jobs require a non-empty sourceId`, { field: 'sourceId' });
	}

	const payload: {
		sourceId: string;
		force?: boolean;
		fallbackOnly?: boolean;
	} = { sourceId };

	const force = asBoolean(job.payload.force);
	if (force !== undefined) {
		payload.force = force;
	}

	const fallbackOnly = asBoolean(job.payload.fallbackOnly);
	if (fallbackOnly !== undefined) {
		payload.fallbackOnly = fallbackOnly;
	}

	return payload;
}

function parseStoryStepPayload(job: WorkerJobEnvelope): {
	storyId: string;
	force?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const storyId = readStringField(job, 'storyId', 'story_id');
	if (!storyId) {
		throw invalidPayload(job, `${job.type} jobs require a non-empty storyId`, { field: 'storyId' });
	}

	const payload: {
		storyId: string;
		force?: boolean;
	} = { storyId };

	const force = asBoolean(job.payload.force);
	if (force !== undefined) {
		payload.force = force;
	}

	return payload;
}

function isPipelineStep(value: string): value is PipelineStepName {
	return value === 'extract' || value === 'segment' || value === 'enrich' || value === 'embed' || value === 'graph';
}

function parsePipelineRunPayload(job: WorkerJobEnvelope): {
	sourceId: string;
	runId?: string;
	from?: PipelineStepName;
	upTo?: PipelineStepName;
	tag?: string;
	force?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(job, 'sourceId', 'source_id');
	if (!sourceId) {
		throw invalidPayload(job, `pipeline_run jobs require a non-empty sourceId`, { field: 'sourceId' });
	}

	const payload: {
		sourceId: string;
		runId?: string;
		from?: PipelineStepName;
		upTo?: PipelineStepName;
		tag?: string;
		force?: boolean;
	} = { sourceId };

	const runId = readStringField(job, 'runId', 'run_id');
	if (runId) {
		payload.runId = runId;
	}

	const from = readStringField(job, 'from');
	if (from) {
		if (!isPipelineStep(from)) {
			throw invalidPayload(job, `pipeline_run jobs require a valid from step`, { field: 'from', value: from });
		}
		payload.from = from;
	}

	const upTo = readStringField(job, 'upTo', 'up_to');
	if (upTo) {
		if (!isPipelineStep(upTo)) {
			throw invalidPayload(job, `pipeline_run jobs require a valid upTo step`, { field: 'upTo', value: upTo });
		}
		payload.upTo = upTo;
	}

	const tag = readStringField(job, 'tag');
	if (tag) {
		payload.tag = tag;
	}

	const force = asBoolean(job.payload.force);
	if (force !== undefined) {
		payload.force = force;
	}

	return payload;
}

function parseDocumentUploadFinalizePayload(job: WorkerJobEnvelope): {
	sourceId: string;
	filename: string;
	storagePath: string;
	tags?: string[];
	startPipeline?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(job, 'sourceId', 'source_id');
	const filename = readStringField(job, 'filename');
	const storagePath = readStringField(job, 'storagePath', 'storage_path');
	if (!sourceId || !filename || !storagePath) {
		throw invalidPayload(job, 'document_upload_finalize jobs require sourceId, filename, and storagePath', {
			field: 'payload',
		});
	}

	const payload: {
		sourceId: string;
		filename: string;
		storagePath: string;
		tags?: string[];
		startPipeline?: boolean;
	} = {
		sourceId,
		filename,
		storagePath,
	};

	if (Array.isArray(job.payload.tags)) {
		payload.tags = job.payload.tags.filter((tag): tag is string => typeof tag === 'string');
	}

	const startPipeline = asBoolean(job.payload.startPipeline);
	if (startPipeline !== undefined) {
		payload.startPipeline = startPipeline;
	}

	return payload;
}

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

async function finalizeUploadedDocument(
	context: {
		config: MulderConfig;
		services: Services;
		pool: import('pg').Pool;
		log: ReturnType<typeof createChildLogger>;
	},
	payload: ReturnType<typeof parseDocumentUploadFinalizePayload>,
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
				type: 'pipeline_run',
				payload: {
					sourceId: source.id,
					runId: run.id,
					from: 'extract',
					force: false,
					tag: BROWSER_UPLOAD_PIPELINE_TAG,
				},
				maxAttempts: 3,
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
			const payload = parseSourceStepPayload(job);
			const result = await executeExtract(payload, config, services, pool, log);
			assertStepSucceeded(job, 'extract', result.status);
			return;
		}
		case 'segment': {
			const payload = parseSourceStepPayload(job);
			const result = await executeSegment(payload, config, services, pool, log);
			assertStepSucceeded(job, 'segment', result.status);
			return;
		}
		case 'enrich': {
			const payload = parseStoryStepPayload(job);
			const result = await executeEnrich(payload, config, services, pool, log);
			assertStepSucceeded(job, 'enrich', result.status);
			return;
		}
		case 'embed': {
			const payload = parseStoryStepPayload(job);
			const result = await executeEmbed(payload, config, services, pool, log);
			assertStepSucceeded(job, 'embed', result.status);
			return;
		}
		case 'graph': {
			const payload = parseStoryStepPayload(job);
			const result = await executeGraph(payload, config, services, pool, log);
			assertStepSucceeded(job, 'graph', result.status);
			return;
		}
		case 'document_upload_finalize': {
			const payload = parseDocumentUploadFinalizePayload(job);
			return await finalizeUploadedDocument({ config, services, pool, log }, payload);
		}
		case 'pipeline_run': {
			const payload = parsePipelineRunPayload(job);
			if (!payload.runId) {
				const result = await executeExtract(
					{ sourceId: payload.sourceId, force: payload.force ?? false },
					config,
					services,
					pool,
					log,
				);
				assertStepSucceeded(job, 'pipeline_run', result.status);
				return;
			}

			const runOptions: PipelineRunOptions = {
				sourceIds: [payload.sourceId],
				force: payload.force ?? false,
			};
			if (payload.runId) {
				runOptions.runId = payload.runId;
			}
			if (payload.from) {
				runOptions.from = payload.from;
			}
			if (payload.upTo) {
				runOptions.upTo = payload.upTo;
			}
			if (payload.tag) {
				runOptions.tag = payload.tag;
			}
			const result = await executePipelineRun({ options: runOptions }, config, services, pool, log);
			assertPipelineRunCompleted(job, result.status);
			return;
		}
		default:
			throw new WorkerError(`Unsupported job type "${job.type}"`, WORKER_ERROR_CODES.WORKER_UNKNOWN_JOB_TYPE, {
				context: { jobId: job.id, jobType: job.type },
			});
	}
};
