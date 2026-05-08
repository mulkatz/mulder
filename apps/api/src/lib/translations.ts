import {
	type AccessPrincipal,
	allowedSensitivityLevelsForMax,
	DATABASE_ERROR_CODES,
	DatabaseError,
	enqueueJob,
	findCurrentTranslatedDocument,
	findSourceById,
	getWorkerPool,
	listTranslatedDocumentsForSource,
	loadConfig,
	type MulderConfig,
	MulderError,
	normalizeSensitivityMetadata,
	resolveAccessPolicy,
	type TranslatedDocument,
} from '@mulder/core';
import type pg from 'pg';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	CreateTranslationRequest,
	TranslationAcceptedResponse,
	TranslationDetailResponse,
	TranslationListQuery,
	TranslationListResponse,
	TranslationResponse,
} from '../routes/translations.schemas.js';

interface TranslationContext {
	config: MulderConfig;
	pool: pg.Pool;
}

interface TranslationRouteOptions {
	authPrincipal?: AuthPrincipal;
}

const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND';
const TRANSLATION_NOT_FOUND_CODE = 'TRANSLATION_NOT_FOUND';

let cachedContext: TranslationContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function resolveContext(): TranslationContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for translation routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{ context: { configPath } },
		);
	}

	cachedContext = {
		config,
		pool: getWorkerPool(config.gcp.cloud_sql),
	};
	cachedConfigPath = configPath;
	return cachedContext;
}

function mapAuthPrincipal(principal: AuthPrincipal | undefined): AccessPrincipal {
	if (!principal) {
		return { kind: 'service' };
	}
	if (principal.type === 'api_key') {
		return { kind: 'api_key' };
	}
	return {
		kind: 'browser_session',
		browserRole: principal.role,
	};
}

function resolveReadMaxSensitivity(config: MulderConfig, authPrincipal: AuthPrincipal | undefined) {
	const policy = resolveAccessPolicy(config, mapAuthPrincipal(authPrincipal));
	if (!policy.permissions.includes('read') && !policy.permissions.includes('admin')) {
		throw new MulderError('The current principal cannot read translations', 'AUTH_FORBIDDEN', {
			context: { principal_kind: policy.principalKind },
		});
	}
	return policy.enabled ? policy.maxSensitivityLevel : undefined;
}

async function requireSource(
	pool: pg.Pool,
	sourceId: string,
	maxSensitivityLevel?: TranslatedDocument['sensitivityLevel'],
) {
	const source = await findSourceById(pool, sourceId, { maxSensitivityLevel });
	if (!source) {
		throw new MulderError(`Document not found: ${sourceId}`, DOCUMENT_NOT_FOUND_CODE, {
			context: { id: sourceId },
		});
	}
	return source;
}

function mapTranslation(document: TranslatedDocument): TranslationResponse {
	return {
		id: document.id,
		source_document_id: document.sourceDocumentId,
		source_language: document.sourceLanguage,
		target_language: document.targetLanguage,
		translation_engine: document.translationEngine,
		translation_date: document.translationDate.toISOString(),
		content: document.content,
		content_hash: document.contentHash,
		status: document.status,
		pipeline_path: document.pipelinePath,
		output_format: document.outputFormat,
		sensitivity_level: document.sensitivityLevel,
		created_at: document.createdAt.toISOString(),
		updated_at: document.updatedAt.toISOString(),
	};
}

async function countTranslationsForSource(
	pool: pg.Pool,
	sourceId: string,
	query: TranslationListQuery,
	maxSensitivityLevel?: TranslatedDocument['sensitivityLevel'],
): Promise<number> {
	const conditions = [
		'translated_documents.source_document_id = $1',
		"sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')",
	];
	const params: unknown[] = [sourceId];
	let paramIndex = 2;

	if (query.target_language) {
		conditions.push(`translated_documents.target_language = $${paramIndex}`);
		params.push(query.target_language);
		paramIndex++;
	}
	if (query.status) {
		conditions.push(`translated_documents.status = $${paramIndex}`);
		params.push(query.status);
		paramIndex++;
	}
	if (maxSensitivityLevel) {
		conditions.push(`translated_documents.sensitivity_level = ANY($${paramIndex})`);
		params.push(allowedSensitivityLevelsForMax(maxSensitivityLevel));
	}

	const result = await pool.query<{ count: string }>(
		`
			SELECT COUNT(*) AS count
			FROM translated_documents
			JOIN sources ON sources.id = translated_documents.source_document_id
			WHERE ${conditions.join(' AND ')}
		`,
		params,
	);
	return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
}

async function findTranslationById(
	pool: pg.Pool,
	translationId: string,
	maxSensitivityLevel?: TranslatedDocument['sensitivityLevel'],
): Promise<TranslatedDocument | null> {
	const conditions = [
		'translated_documents.id = $1',
		"sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')",
	];
	const params: unknown[] = [translationId];
	if (maxSensitivityLevel) {
		conditions.push('translated_documents.sensitivity_level = ANY($2)');
		params.push(allowedSensitivityLevelsForMax(maxSensitivityLevel));
	}

	const result = await pool.query<{
		id: string;
		source_document_id: string;
		source_language: string;
		target_language: string;
		translation_engine: string;
		translation_date: Date;
		content: string;
		content_hash: string;
		status: TranslatedDocument['status'];
		pipeline_path: TranslatedDocument['pipelinePath'];
		output_format: TranslatedDocument['outputFormat'];
		sensitivity_level: TranslatedDocument['sensitivityLevel'];
		sensitivity_metadata: unknown;
		created_at: Date;
		updated_at: Date;
	}>(
		`
			SELECT translated_documents.*
			FROM translated_documents
			JOIN sources ON sources.id = translated_documents.source_document_id
			WHERE ${conditions.join(' AND ')}
		`,
		params,
	);
	const row = result.rows[0];
	if (!row) {
		return null;
	}

	return {
		id: row.id,
		sourceDocumentId: row.source_document_id,
		sourceLanguage: row.source_language,
		targetLanguage: row.target_language,
		translationEngine: row.translation_engine,
		translationDate: row.translation_date,
		content: row.content,
		contentHash: row.content_hash,
		status: row.status,
		pipelinePath: row.pipeline_path,
		outputFormat: row.output_format,
		sensitivityLevel: row.sensitivity_level,
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function listDocumentTranslations(
	sourceId: string,
	query: TranslationListQuery,
	options?: TranslationRouteOptions,
): Promise<TranslationListResponse> {
	const { config, pool } = resolveContext();
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal);
	await requireSource(pool, sourceId, maxSensitivityLevel);

	const [count, translations] = await Promise.all([
		countTranslationsForSource(pool, sourceId, query, maxSensitivityLevel),
		listTranslatedDocumentsForSource(pool, sourceId, {
			targetLanguage: query.target_language,
			status: query.status,
			maxSensitivityLevel,
			limit: query.limit,
			offset: query.offset,
		}),
	]);

	return {
		data: translations.map(mapTranslation),
		meta: {
			count,
			limit: query.limit,
			offset: query.offset,
		},
	};
}

export async function requestDocumentTranslation(
	sourceId: string,
	input: CreateTranslationRequest,
	options?: TranslationRouteOptions,
): Promise<{ status: 200; body: TranslationDetailResponse } | { status: 202; body: TranslationAcceptedResponse }> {
	const { config, pool } = resolveContext();
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal);
	await requireSource(pool, sourceId, maxSensitivityLevel);
	const outputFormat = input.output_format ?? config.translation.output_format;

	if (!input.refresh) {
		const cached = await findCurrentTranslatedDocument(pool, sourceId, input.target_language, { maxSensitivityLevel });
		if (cached && cached.outputFormat === outputFormat) {
			return {
				status: 200,
				body: {
					data: mapTranslation(cached),
				},
			};
		}
	}

	const job = await enqueueJob(pool, {
		type: 'translate',
		payload: {
			sourceId,
			targetLanguage: input.target_language,
			sourceLanguage: input.source_language,
			pipelinePath: input.pipeline_path,
			outputFormat,
			refresh: input.refresh,
		},
		maxAttempts: 3,
	});

	return {
		status: 202,
		body: {
			data: {
				job_id: job.id,
				status: 'pending',
			},
			links: {
				status: `/api/jobs/${job.id}`,
			},
		},
	};
}

export async function getTranslation(
	translationId: string,
	options?: TranslationRouteOptions,
): Promise<TranslationDetailResponse> {
	const { config, pool } = resolveContext();
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal);
	const translation = await findTranslationById(pool, translationId, maxSensitivityLevel);
	if (!translation) {
		throw new MulderError(`Translation not found: ${translationId}`, TRANSLATION_NOT_FOUND_CODE, {
			context: { translationId },
		});
	}
	return {
		data: mapTranslation(translation),
	};
}
