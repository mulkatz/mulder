import { createHash, randomUUID } from 'node:crypto';
import {
	createChildLogger,
	createIntakeEnrichmentSuggestion,
	createLogger,
	createServiceRegistry,
	DATABASE_ERROR_CODES,
	DatabaseError,
	findJobById,
	findSourceById,
	getWorkerPool,
	INGEST_ERROR_CODES,
	type Job,
	type Logger,
	loadConfig,
	type MulderConfig,
	MulderError,
	type Services,
	type Source,
} from '@mulder/core';
import type pg from 'pg';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	CompleteDocumentUploadRequest,
	CompleteDocumentUploadResponse,
	EnrichUploadProvenanceRequest,
	EnrichUploadProvenanceResponse,
	InitiateDocumentUploadRequest,
	InitiateDocumentUploadResponse,
	UploadFinalizationStatusResponse,
} from '../routes/uploads.schemas.js';
import {
	canonicalUploadExtensionForContentType,
	canonicalUploadExtensionForFilename,
	isSupportedOriginalStoragePath,
	type UploadStorageExtension,
} from '../routes/uploads.schemas.js';
import { isOperatorPrincipal, resolveReadMaxSensitivity, toIsoString } from './api-runtime.js';

interface UploadContext {
	config: MulderConfig;
	pool: pg.Pool;
	services: Services;
}

interface UploadRouteOptions {
	authPrincipal?: AuthPrincipal;
}

type Queryable = pg.Pool | pg.PoolClient;
type EnrichmentSuggestedSensitivity = NonNullable<
	EnrichUploadProvenanceResponse['data']['suggested']['expected_sensitivity']
>;
type EnrichmentSuggestedProvenance = NonNullable<EnrichUploadProvenanceResponse['data']['suggested']['provenance']>;
type EnrichmentSuggestedOriginalSource = NonNullable<EnrichmentSuggestedProvenance['original_source']>;
type EnrichmentSuggestedOriginalSourceType = EnrichmentSuggestedOriginalSource['source_type'];
type EnrichmentSuggestedSensitivityLevel = EnrichmentSuggestedSensitivity['level'];
type EnrichmentSuggestedPiiType = NonNullable<EnrichmentSuggestedSensitivity['pii_types']>[number];

let cachedContext: UploadContext | null = null;
let cachedConfigPath: string | null = null;

const FINALIZE_JOB_TYPE = 'document_upload_finalize';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_UPLOAD_SOURCE_TYPES: ReadonlySet<EnrichmentSuggestedOriginalSourceType> = new Set([
	'witness_report',
	'government_document',
	'academic_paper',
	'news_article',
	'correspondence',
	'field_notes',
	'measurement_data',
	'photograph',
	'audio_recording',
	'video_recording',
	'other',
]);
const ALLOWED_UPLOAD_SENSITIVITY_LEVELS: ReadonlySet<EnrichmentSuggestedSensitivityLevel> = new Set([
	'public',
	'internal',
	'restricted',
	'confidential',
]);
const ALLOWED_UPLOAD_PII_TYPES: ReadonlySet<EnrichmentSuggestedPiiType> = new Set([
	'person_name',
	'contact_info',
	'medical_data',
	'location_private',
	'location_sighting',
	'financial',
	'unpublished_research',
	'legal',
]);

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

function uploadFinalizationNotFound(jobId: string): never {
	throw new DatabaseError(`Upload finalization not found: ${jobId}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
		context: { job_id: jobId },
	});
}

function readPayloadString(payload: Job['payload'], key: string): string | null {
	const value = payload[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPayloadUuid(payload: Job['payload'], key: string): string | null {
	const value = readPayloadString(payload, key);
	return value && UUID_PATTERN.test(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	return Object.fromEntries(Object.entries(value));
}

function readSubmittedByUserId(payload: Job['payload']): string | null {
	const submittedBy = readRecord(payload.submittedBy ?? payload.submitted_by);
	if (!submittedBy) return null;
	const userId = submittedBy.userId ?? submittedBy.user_id;
	return typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
}

async function findSourceVisibleToPrincipal(
	pool: pg.Pool,
	sourceId: string | null,
	authPrincipal: AuthPrincipal | undefined,
	maxSensitivityLevel?: Source['sensitivityLevel'],
): Promise<Source | null> {
	if (!sourceId) {
		return null;
	}
	if (isOperatorPrincipal(authPrincipal)) {
		return await findSourceById(pool, sourceId);
	}
	return await findSourceById(pool, sourceId, { maxSensitivityLevel });
}

function mapVisibleUploadSource(source: Source): NonNullable<UploadFinalizationStatusResponse['data']['source']> {
	return {
		id: source.id,
		filename: source.filename,
		status: source.status,
		links: {
			document: `/api/documents/${source.id}`,
		},
	};
}

function resolveUploadInput(input: { filename: string; contentType: string }): {
	mediaType: string;
	storageExtension: UploadStorageExtension;
} {
	const extension = canonicalUploadExtensionForFilename(input.filename);
	const contentTypeExtension = canonicalUploadExtensionForContentType(input.contentType);

	if (!extension) {
		throw new MulderError(
			'Filename must end with .pdf, .png, .jpg, .jpeg, .tif, .tiff, .txt, .md, .markdown, .docx, .csv, .xlsx, .eml, or .msg',
			'VALIDATION_ERROR',
			{
				context: { filename: input.filename },
			},
		);
	}

	if (!contentTypeExtension) {
		throw new MulderError(
			'Only PDF, PNG, JPEG, TIFF, TXT, Markdown, DOCX, CSV, XLSX, EML, and MSG uploads are supported',
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

function submittedByForPrincipal(principal: AuthPrincipal | undefined) {
	if (!principal) {
		return { userId: 'api', type: 'system', role: 'api' };
	}
	if (principal.type === 'api_key') {
		return { userId: `api-key:${principal.keyName}`, type: 'system', role: 'api_key' };
	}
	return { userId: principal.userId, type: 'human', role: principal.role };
}

function mapUploadProvenance(input: CompleteDocumentUploadRequest['provenance']) {
	if (!input) {
		return undefined;
	}

	return {
		context: {
			channel: input.acquisition?.channel,
			submittedAt: input.acquisition?.submitted_at,
			collectionId: input.acquisition?.collection_id,
			submissionNotes: input.acquisition?.notes,
			submissionMetadata: input.acquisition?.metadata,
			authenticityStatus: input.authenticity?.status,
			authenticityNotes: input.authenticity?.notes,
		},
		originalSource: input.original_source
			? {
					sourceType: input.original_source.source_type,
					sourceDescription: input.original_source.description,
					sourceDate: input.original_source.source_date,
					sourceAuthor: input.original_source.author,
					sourceLanguage: input.original_source.language,
					sourceInstitution: input.original_source.institution,
					foiaReference: input.original_source.foia_reference,
				}
			: undefined,
		custodyChain: input.custody_chain?.map((step) => ({
			stepOrder: step.step_order,
			holder: step.holder,
			holderType: step.holder_type,
			receivedFrom: step.received_from,
			heldFrom: step.held_from,
			heldUntil: step.held_until,
			actions: step.actions,
			location: step.location,
			notes: step.notes,
		})),
		archiveLocation: input.archive_location
			? {
					archiveId: input.archive_location.archive_id,
					originalPath: input.archive_location.original_path,
					originalFilename: input.archive_location.original_filename,
					pathSegments: input.archive_location.path_segments?.map((segment) => ({
						depth: segment.depth,
						name: segment.name,
						segmentType: segment.segment_type,
					})),
					physicalLocation: input.archive_location.physical_location,
					sourceStatus: input.archive_location.source_status,
					recordedAt: input.archive_location.recorded_at,
					validFrom: input.archive_location.valid_from,
					validUntil: input.archive_location.valid_until,
				}
			: undefined,
	};
}

function mapExpectedSensitivity(input: CompleteDocumentUploadRequest['expected_sensitivity']) {
	if (!input) {
		return undefined;
	}
	return {
		level: input.level,
		reason: input.reason,
		piiTypes: input.pii_types,
		declassifyDate: input.declassify_date,
	};
}

function expectedOriginalStoragePath(input: EnrichUploadProvenanceRequest): string {
	const extension = canonicalUploadExtensionForFilename(input.filename);
	if (!extension) {
		throw new MulderError('Filename must end with a supported upload extension before enrichment', 'VALIDATION_ERROR', {
			context: { filename: input.filename },
		});
	}
	return `raw/${input.source_id}/original.${extension}`;
}

function previewUploadedObject(content: Buffer, contentType: string | null, filename: string): string {
	const normalizedContentType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
	const lowerFilename = filename.toLowerCase();
	if (
		normalizedContentType.startsWith('text/') ||
		lowerFilename.endsWith('.txt') ||
		lowerFilename.endsWith('.md') ||
		lowerFilename.endsWith('.markdown') ||
		lowerFilename.endsWith('.csv')
	) {
		return content.toString('utf8', 0, Math.min(content.byteLength, 16_000));
	}
	return [
		`Filename: ${filename}`,
		`Content type: ${contentType ?? 'unknown'}`,
		`Size bytes: ${content.byteLength}`,
		'Binary preview is intentionally limited before finalization.',
	].join('\n');
}

function safeEnumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | null {
	if (typeof value !== 'string') return null;
	for (const allowedValue of allowed) {
		if (allowedValue === value) return allowedValue;
	}
	return null;
}

function safeLanguage(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase();
	return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(normalized) && normalized.length <= 16 ? normalized : undefined;
}

function safePiiTypes(value: unknown): EnrichmentSuggestedPiiType[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is EnrichmentSuggestedPiiType => safeEnumValue(item, ALLOWED_UPLOAD_PII_TYPES) !== null,
	);
}

export function sanitizeEnrichmentSuggestion(
	value: unknown,
	draft: EnrichUploadProvenanceRequest['draft'] | undefined,
): EnrichUploadProvenanceResponse['data']['suggested'] {
	const candidate = readRecord(value) ?? {};
	const suggested = readRecord(candidate.suggested) ?? candidate;
	const provenance = readRecord(suggested.provenance) ?? {};
	const expectedSensitivity = readRecord(suggested.expected_sensitivity) ?? null;

	const safeProvenance: EnrichmentSuggestedProvenance = {
		custody_chain: [],
	};
	const draftProvenance = draft?.provenance;
	if (
		draftProvenance?.acquisition?.channel ||
		draftProvenance?.acquisition?.collection_id ||
		draftProvenance?.acquisition?.notes
	) {
		safeProvenance.acquisition = {
			...draftProvenance.acquisition,
			metadata: draftProvenance.acquisition?.metadata ?? {},
		};
	}
	if (
		provenance.original_source &&
		typeof provenance.original_source === 'object' &&
		!Array.isArray(provenance.original_source)
	) {
		const original = readRecord(provenance.original_source) ?? {};
		const sourceType = safeEnumValue(original.source_type, ALLOWED_UPLOAD_SOURCE_TYPES);
		const language = safeLanguage(original.language);
		const description =
			typeof original.description === 'string' && original.description.trim().length > 0
				? original.description.trim()
				: null;
		if (description || language || sourceType) {
			safeProvenance.original_source = {
				source_type: sourceType ?? 'other',
				...(description ? { description } : {}),
				...(language ? { language } : {}),
			};
		}
	}
	safeProvenance.authenticity = {
		status: draftProvenance?.authenticity?.status ?? 'unverified',
		notes: draftProvenance?.authenticity?.notes ?? 'AI suggestion; verify before completing provenance.',
	};
	if (draftProvenance?.custody_chain && draftProvenance.custody_chain.length > 0) {
		safeProvenance.custody_chain = draftProvenance.custody_chain;
	}

	const suggestedPayload: EnrichUploadProvenanceResponse['data']['suggested'] = {
		provenance: safeProvenance,
	};
	if (expectedSensitivity && safeEnumValue(expectedSensitivity.level, ALLOWED_UPLOAD_SENSITIVITY_LEVELS) !== null) {
		const level = safeEnumValue(expectedSensitivity.level, ALLOWED_UPLOAD_SENSITIVITY_LEVELS) ?? 'internal';
		suggestedPayload.expected_sensitivity = {
			level,
			reason:
				typeof expectedSensitivity.reason === 'string' && expectedSensitivity.reason.trim().length > 0
					? expectedSensitivity.reason
					: 'AI suggested sensitivity; review before upload completion.',
			pii_types: safePiiTypes(expectedSensitivity.pii_types),
		};
	}
	return suggestedPayload;
}

function readConfidenceMap(value: unknown): Record<string, number> {
	const record = readRecord(value);
	if (!record) return {};
	const source = record.field_confidence;
	if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
	return Object.fromEntries(
		Object.entries(source)
			.filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] >= 0 && entry[1] <= 1)
			.map(([key, confidence]) => [key, confidence]),
	);
}

function readWarnings(value: unknown): string[] {
	const record = readRecord(value);
	if (!record) return [];
	const warnings = record.warnings;
	return Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string') : [];
}

export async function enrichUploadProvenance(
	input: EnrichUploadProvenanceRequest,
	logger?: Logger,
	options?: UploadRouteOptions,
): Promise<EnrichUploadProvenanceResponse> {
	const { config, pool, services } = resolveContext();
	const requestLogger = createRouteLogger(logger ?? createLogger(), {
		action: 'enrich-provenance',
		source_id: input.source_id,
	});

	if (
		!isSupportedOriginalStoragePath(input.storage_path) ||
		input.storage_path !== expectedOriginalStoragePath(input)
	) {
		throw new MulderError('storage_path must reference the initiated original upload object', 'VALIDATION_ERROR', {
			context: { source_id: input.source_id, storage_path: input.storage_path },
		});
	}

	const metadata = await services.storage.getMetadata(input.storage_path);
	if (!metadata) {
		throw new MulderError(`Uploaded object not found: ${input.storage_path}`, 'UPLOAD_OBJECT_NOT_FOUND', {
			context: { source_id: input.source_id, storage_path: input.storage_path },
		});
	}

	const content = await services.storage.download(input.storage_path);
	const fileHash = createHash('sha256').update(content).digest('hex');
	const preview = previewUploadedObject(content, metadata.contentType, input.filename);
	const prompt = [
		'Suggest provenance fields for a newly uploaded research source.',
		'Return advisory JSON only. Do not state acquisition, custody, or authenticity as fact unless the draft supplies it.',
		'Default authenticity to unverified. Sensitivity suggestions must include a short reason.',
		`Filename: ${input.filename}`,
		`Collection id: ${input.collection_id ?? 'none'}`,
		`Draft: ${JSON.stringify(input.draft ?? {})}`,
		'Preview:',
		preview,
	].join('\n\n');

	const rawSuggestion = await services.llm.generateStructured({
		prompt,
		systemInstruction: 'You are assisting provenance intake. Produce cautious, user-reviewable suggestions only.',
		schema: {
			type: 'object',
			properties: {
				suggested: { type: 'object' },
				field_confidence: { type: 'object' },
				warnings: { type: 'array', items: { type: 'string' } },
			},
			required: ['suggested', 'field_confidence', 'warnings'],
		},
	});

	const suggested = sanitizeEnrichmentSuggestion(rawSuggestion, input.draft);
	const warnings = ['Review AI-suggested provenance before completing the upload.', ...readWarnings(rawSuggestion)];
	const fieldConfidence = readConfidenceMap(rawSuggestion);
	const suggestion = await createIntakeEnrichmentSuggestion(pool, {
		sourceId: input.source_id,
		storagePath: input.storage_path,
		filename: input.filename,
		fileHash,
		model: config.translation.engine,
		promptVersion: 'intake-provenance-v1',
		suggestedPayload: suggested,
		fieldConfidence,
		warnings,
		requestedBy: submittedByForPrincipal(options?.authPrincipal),
	});

	requestLogger.info({ suggestionId: suggestion.id }, 'Upload provenance enrichment suggestion created');
	return {
		data: {
			suggestion_id: suggestion.id,
			source_id: input.source_id,
			suggested,
			field_confidence: fieldConfidence,
			warnings,
			requires_user_review: true,
		},
	};
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
	options?: UploadRouteOptions,
): Promise<CompleteDocumentUploadResponse> {
	const { config, pool, services } = resolveContext();
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
	const maxBytes = maxUploadBytes(config);
	if (!Number.isFinite(metadata.sizeBytes) || metadata.sizeBytes < 0 || metadata.sizeBytes > maxBytes) {
		throw new MulderError(
			'Uploaded object exceeds the configured ingest limit',
			INGEST_ERROR_CODES.INGEST_FILE_TOO_LARGE,
			{
				context: {
					source_id: input.source_id,
					storage_path: input.storage_path,
					size_bytes: metadata.sizeBytes,
					max_bytes: maxBytes,
				},
			},
		);
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
					submittedBy: submittedByForPrincipal(options?.authPrincipal),
					provenance: mapUploadProvenance(input.provenance),
					expectedSensitivity: mapExpectedSensitivity(input.expected_sensitivity),
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
			upload_status: `/api/uploads/documents/finalizations/${jobId}`,
		},
	};
}

function deriveUploadFinalizationResultStatus(input: {
	job: Job;
	payloadResultStatus: string | null;
	visibleSource: Source | null;
}): UploadFinalizationStatusResponse['data']['result_status'] {
	if (input.job.status === 'pending' || input.job.status === 'running') {
		return 'pending';
	}
	if (input.job.status === 'failed') {
		return 'failed';
	}
	if (input.job.status === 'dead_letter') {
		return 'dead_letter';
	}
	if (!input.visibleSource) {
		return 'completed_unavailable';
	}
	if (input.payloadResultStatus === 'duplicate') {
		return 'duplicate';
	}
	if (input.payloadResultStatus === 'created') {
		return 'created';
	}
	return 'completed_unavailable';
}

function mapVisiblePipeline(
	job: Job,
	visibleSource: Source | null,
): UploadFinalizationStatusResponse['data']['pipeline'] {
	if (!visibleSource || job.status !== 'completed') {
		return null;
	}

	const pipelineJobId = readPayloadUuid(job.payload, 'pipeline_job_id');
	const pipelineRunId = readPayloadUuid(job.payload, 'pipeline_run_id');
	if (!pipelineJobId && !pipelineRunId) {
		return null;
	}

	return {
		job_id: pipelineJobId,
		run_id: pipelineRunId,
		links: {
			job: pipelineJobId ? `/api/jobs/${pipelineJobId}` : null,
		},
	};
}

async function canInspectUploadFinalization(input: {
	pool: pg.Pool;
	job: Job;
	requestedSourceId: string;
	resolvedSourceId: string | null;
	authPrincipal: AuthPrincipal | undefined;
	maxSensitivityLevel?: Source['sensitivityLevel'];
}): Promise<boolean> {
	if (isOperatorPrincipal(input.authPrincipal)) {
		return true;
	}
	if (input.authPrincipal?.type !== 'session') {
		return false;
	}

	if (readSubmittedByUserId(input.job.payload) === input.authPrincipal.userId) {
		return true;
	}

	const requestedSource = await findSourceVisibleToPrincipal(
		input.pool,
		input.requestedSourceId,
		input.authPrincipal,
		input.maxSensitivityLevel,
	);
	if (requestedSource) {
		return true;
	}

	const resolvedSource = await findSourceVisibleToPrincipal(
		input.pool,
		input.resolvedSourceId,
		input.authPrincipal,
		input.maxSensitivityLevel,
	);
	return Boolean(resolvedSource);
}

export async function getDocumentUploadFinalizationStatus(
	jobId: string,
	options?: UploadRouteOptions,
): Promise<UploadFinalizationStatusResponse> {
	const { config, pool } = resolveContext();
	const job = await findJobById(pool, jobId);
	if (!job || job.type !== FINALIZE_JOB_TYPE) {
		uploadFinalizationNotFound(jobId);
	}

	const requestedSourceId = readPayloadUuid(job.payload, 'sourceId') ?? readPayloadUuid(job.payload, 'source_id');
	if (!requestedSourceId) {
		uploadFinalizationNotFound(jobId);
	}

	const resolvedSourceId =
		readPayloadUuid(job.payload, 'resolved_source_id') ?? readPayloadUuid(job.payload, 'duplicate_of_source_id');
	let maxSensitivityLevel: Source['sensitivityLevel'] | undefined;
	if (!isOperatorPrincipal(options?.authPrincipal)) {
		try {
			maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'upload finalizations');
		} catch {
			uploadFinalizationNotFound(jobId);
		}
	}

	const canInspect = await canInspectUploadFinalization({
		pool,
		job,
		requestedSourceId,
		resolvedSourceId,
		authPrincipal: options?.authPrincipal,
		maxSensitivityLevel,
	});
	if (!canInspect) {
		uploadFinalizationNotFound(jobId);
	}

	const resolvedVisibleSource = await findSourceVisibleToPrincipal(
		pool,
		resolvedSourceId ?? requestedSourceId,
		options?.authPrincipal,
		maxSensitivityLevel,
	);
	const visibleSource = job.status === 'completed' ? resolvedVisibleSource : null;
	const resultStatus = deriveUploadFinalizationResultStatus({
		job,
		payloadResultStatus: readPayloadString(job.payload, 'result_status'),
		visibleSource,
	});
	const source =
		visibleSource && (resultStatus === 'created' || resultStatus === 'duplicate')
			? mapVisibleUploadSource(visibleSource)
			: null;
	const response: UploadFinalizationStatusResponse = {
		data: {
			job_id: job.id,
			requested_source_id: requestedSourceId,
			job_status: job.status,
			result_status: resultStatus,
			source,
			pipeline: mapVisiblePipeline(job, source ? visibleSource : null),
			created_at: job.createdAt.toISOString(),
			started_at: toIsoString(job.startedAt),
			finished_at: toIsoString(job.finishedAt),
		},
		links: {
			job: `/api/jobs/${job.id}`,
			...(source ? { source: source.links.document } : {}),
		},
	};
	return response;
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
