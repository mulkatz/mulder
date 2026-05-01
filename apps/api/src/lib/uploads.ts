import { randomUUID } from 'node:crypto';
import {
	createChildLogger,
	createLogger,
	createServiceRegistry,
	DATABASE_ERROR_CODES,
	DatabaseError,
	findSourceById,
	getWorkerPool,
	INGEST_ERROR_CODES,
	type Logger,
	loadConfig,
	type MulderConfig,
	MulderError,
	type Services,
} from '@mulder/core';
import type pg from 'pg';
import type {
	CompleteDocumentUploadRequest,
	CompleteDocumentUploadResponse,
	InitiateDocumentUploadRequest,
	InitiateDocumentUploadResponse,
} from '../routes/uploads.schemas.js';
import {
	canonicalUploadExtensionForContentType,
	canonicalUploadExtensionForFilename,
	isSupportedOriginalStoragePath,
	type UploadStorageExtension,
} from '../routes/uploads.schemas.js';

interface UploadContext {
	config: MulderConfig;
	pool: pg.Pool;
	services: Services;
}

type Queryable = pg.Pool | pg.PoolClient;

let cachedContext: UploadContext | null = null;
let cachedConfigPath: string | null = null;

const FINALIZE_JOB_TYPE = 'document_upload_finalize';

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function createRouteLogger(rootLogger: Logger, metadata: Record<string, string | number | boolean | null | undefined>) {
	return createChildLogger(rootLogger, {
		module: 'api',
		route: 'uploads',
		...metadata,
	});
}

function resolveContext(): UploadContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for upload routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{
				context: { configPath },
			},
		);
	}

	const logger = createLogger();
	cachedContext = {
		config,
		pool: getWorkerPool(config.gcp.cloud_sql),
		services: createServiceRegistry(config, logger),
	};
	cachedConfigPath = configPath;
	return cachedContext;
}

function maxUploadBytes(config: MulderConfig): number {
	return config.ingestion.max_file_size_mb * 1024 * 1024;
}

function resolveUploadInput(input: { filename: string; contentType: string }): {
	mediaType: string;
	storageExtension: UploadStorageExtension;
} {
	const extension = canonicalUploadExtensionForFilename(input.filename);
	const contentTypeExtension = canonicalUploadExtensionForContentType(input.contentType);

	if (!extension) {
		throw new MulderError(
			'Filename must end with .pdf, .png, .jpg, .jpeg, .tif, .tiff, .txt, .md, .markdown, .docx, .csv, or .xlsx',
			'VALIDATION_ERROR',
			{
				context: { filename: input.filename },
			},
		);
	}

	if (!contentTypeExtension) {
		throw new MulderError(
			'Only PDF, PNG, JPEG, TIFF, TXT, Markdown, DOCX, CSV, and XLSX uploads are supported',
			'VALIDATION_ERROR',
			{
				context: { content_type: input.contentType },
			},
		);
	}

	if (extension !== contentTypeExtension) {
		throw new MulderError('Upload filename extension and content_type do not match', 'VALIDATION_ERROR', {
			context: {
				filename: input.filename,
				content_type: input.contentType,
			},
		});
	}

	const normalizedContentType = input.contentType.split(';')[0]?.trim().toLowerCase() ?? input.contentType;
	return {
		mediaType: normalizedContentType,
		storageExtension: extension,
	};
}

async function assertNoInFlightFinalizeJob(pool: Queryable, sourceId: string): Promise<void> {
	const result = await pool.query<{ count: string }>(
		`
			SELECT COUNT(*) AS count
			FROM jobs
			WHERE type = $1
				AND status IN ('pending', 'running')
				AND COALESCE(payload->>'sourceId', payload->>'source_id') = $2
		`,
		[FINALIZE_JOB_TYPE, sourceId],
	);

	if ((Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0) > 0) {
		throw new MulderError(`Upload finalize job already in progress for ${sourceId}`, 'UPLOAD_FINALIZE_CONFLICT', {
			context: { source_id: sourceId },
		});
	}
}

export async function initiateDocumentUpload(
	input: InitiateDocumentUploadRequest,
	logger?: Logger,
): Promise<InitiateDocumentUploadResponse> {
	const { config, services } = resolveContext();
	const requestLogger = createRouteLogger(logger ?? createLogger(), {
		action: 'initiate',
		filename: input.filename,
		size_bytes: input.size_bytes,
	});

	const uploadInput = resolveUploadInput({ filename: input.filename, contentType: input.content_type });
	const maxBytes = maxUploadBytes(config);
	if (input.size_bytes > maxBytes) {
		throw new MulderError(
			'Declared upload exceeds the configured ingest limit',
			INGEST_ERROR_CODES.INGEST_FILE_TOO_LARGE,
			{
				context: {
					filename: input.filename,
					size_bytes: input.size_bytes,
					max_bytes: maxBytes,
				},
			},
		);
	}

	const sourceId = randomUUID();
	const storagePath = `raw/${sourceId}/original.${uploadInput.storageExtension}`;
	const upload = await services.storage.createUploadSession(storagePath, {
		contentType: uploadInput.mediaType,
		expectedSizeBytes: input.size_bytes,
	});

	requestLogger.info({ sourceId, storagePath, transport: upload.transport }, 'Document upload initiated');

	return {
		data: {
			source_id: sourceId,
			storage_path: storagePath,
			upload: {
				url: upload.url,
				method: upload.method,
				headers: upload.headers,
				transport: upload.transport,
				expires_at: upload.expiresAt,
			},
			limits: {
				max_bytes: maxBytes,
			},
		},
	};
}

export async function completeDocumentUpload(
	input: CompleteDocumentUploadRequest,
	logger?: Logger,
): Promise<CompleteDocumentUploadResponse> {
	const { pool, services } = resolveContext();
	const requestLogger = createRouteLogger(logger ?? createLogger(), {
		action: 'complete',
		source_id: input.source_id,
		start_pipeline: input.start_pipeline,
	});

	const metadata = await services.storage.getMetadata(input.storage_path);
	if (!metadata) {
		throw new MulderError(`Uploaded object not found: ${input.storage_path}`, 'UPLOAD_OBJECT_NOT_FOUND', {
			context: { source_id: input.source_id, storage_path: input.storage_path },
		});
	}

	const client = await pool.connect();
	let jobId: string | undefined;
	try {
		await client.query('BEGIN');
		await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [197, input.source_id]);

		const existingSource = await findSourceById(client, input.source_id);
		if (existingSource) {
			throw new MulderError(`Upload already finalized for ${input.source_id}`, 'UPLOAD_ALREADY_FINALIZED_CONFLICT', {
				context: { source_id: input.source_id },
			});
		}

		await assertNoInFlightFinalizeJob(client, input.source_id);

		const result = await client.query<{ id: string }>(
			`
				INSERT INTO jobs (type, payload, max_attempts)
				VALUES ($1, $2::jsonb, 3)
				RETURNING id
			`,
			[
				FINALIZE_JOB_TYPE,
				JSON.stringify({
					sourceId: input.source_id,
					filename: input.filename,
					storagePath: input.storage_path,
					tags: input.tags ?? [],
					startPipeline: input.start_pipeline,
					declaredSizeBytes: metadata.sizeBytes,
				}),
			],
		);

		jobId = result.rows[0]?.id;
		if (!jobId) {
			throw new DatabaseError('Failed to enqueue upload finalize job', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
				context: { source_id: input.source_id },
			});
		}

		await client.query('COMMIT');
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

	requestLogger.info({ jobId, sourceId: input.source_id }, 'Document upload finalize job enqueued');

	return {
		data: {
			job_id: jobId,
			status: 'pending',
			source_id: input.source_id,
		},
		links: {
			status: `/api/jobs/${jobId}`,
		},
	};
}

export async function handleDevUploadProxy(
	storagePath: string,
	body: Buffer,
	contentType: string,
	logger?: Logger,
): Promise<void> {
	const { config, services } = resolveContext();
	if (!(config.dev_mode || process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development')) {
		throw new MulderError('Dev upload proxy is unavailable', 'UPLOAD_PROXY_FORBIDDEN');
	}

	if (!isSupportedOriginalStoragePath(storagePath)) {
		throw new MulderError('Invalid storage path for dev upload', 'VALIDATION_ERROR', {
			context: { storage_path: storagePath },
		});
	}

	await services.storage.upload(storagePath, body, contentType);
	createRouteLogger(logger ?? createLogger(), {
		action: 'dev-upload',
		storage_path: storagePath,
		bytes: body.length,
	}).info('Document upload proxy stored bytes');
}
