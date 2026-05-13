import { performance } from 'node:perf_hooks';
import {
	type AccessPrincipal,
	allowedSensitivityLevelsForMax,
	countProcessedSources,
	countSources,
	createChildLogger,
	createLogger,
	createServiceRegistry,
	DATABASE_ERROR_CODES,
	DatabaseError,
	type Entity,
	findAllSources,
	findEntitiesByStoryId,
	findLatestDocumentQualityAssessment,
	findLatestPipelineRunSourceForSource,
	findOriginalSourceForContext,
	findPipelineRunById,
	findSourceById,
	findSourceCredibilityProfileBySourceId,
	findSourceSteps,
	findStoriesBySourceId,
	getQueryPool,
	type Job,
	type Logger,
	listAcquisitionContextsForSource,
	loadConfig,
	type MulderConfig,
	MulderError,
	type PipelineRun,
	type PipelineRunSource,
	presentCorroborationScore,
	resolveAccessPolicy,
	type Services,
	type Source,
	type SourceFilter,
	type SourceStep,
	type Story,
	summarizeCollection,
} from '@mulder/core';
import type pg from 'pg';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	DocumentArtifact,
	DocumentDetailResponse,
	DocumentListItem,
	DocumentListQuery,
	DocumentListResponse,
	DocumentObservabilityResponse,
	DocumentPageItem,
	DocumentPagesResponse,
	DocumentStoriesResponse,
	DocumentStoryResponse,
} from '../routes/documents.schemas.js';
import { PIPELINE_STEP_VALUES } from '../routes/pipeline.schemas.js';
import { unknownToJsonRecord } from './json-record.js';

interface DocumentContext {
	config: MulderConfig;
	pool: pg.Pool;
}

interface RouteAccessOptions {
	authPrincipal?: AuthPrincipal;
}

const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND';
const PDF_CONTENT_TYPE = 'application/pdf';
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
const PNG_CONTENT_TYPE = 'image/png';

type DocumentListHints = Pick<
	DocumentListItem,
	'source_language' | 'sensitivity_level' | 'quality_hint' | 'credibility_hint' | 'collection_hint' | 'provenance_hint'
>;

interface DocumentQualityHintRow {
	source_id: string;
	overall_quality: string;
	processable: boolean;
	recommended_path: string;
	language: string | null;
}

interface DocumentCredibilityHintRow {
	source_id: string;
	review_status: string;
	sensitivity_level: DocumentListHints['sensitivity_level'];
	average_score: string | number | null;
}

interface DocumentProvenanceHintRow {
	source_id: string;
	channel: string;
	submitted_at: Date;
	authenticity_status: string;
	collection_id: string | null;
	collection_name: string | null;
	source_language: string | null;
}

let cachedContext: DocumentContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function createRouteLogger(rootLogger: Logger, metadata: Record<string, string | number | boolean | null | undefined>) {
	return createChildLogger(rootLogger, {
		module: 'api',
		route: 'documents',
		...metadata,
	});
}

function resolveContext(): DocumentContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for document routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{
				context: {
					configPath,
				},
			},
		);
	}

	cachedContext = {
		config,
		pool: getQueryPool(config.gcp.cloud_sql),
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
		throw new MulderError('The current principal cannot read documents', 'AUTH_FORBIDDEN', {
			context: { principal_kind: policy.principalKind },
		});
	}
	return policy.enabled ? policy.maxSensitivityLevel : undefined;
}

function toIsoString(value: Date): string {
	return value.toISOString();
}

function buildDocumentLinks(id: string): { pdf: string; layout: string; pages: string } {
	return {
		pdf: `/api/documents/${id}/pdf`,
		layout: `/api/documents/${id}/layout`,
		pages: `/api/documents/${id}/pages`,
	};
}

function mapSourceToDocument(
	source: Source,
	layoutAvailable: boolean,
	pageImageCount: number,
	hints?: DocumentListHints,
): DocumentListItem {
	return {
		id: source.id,
		filename: source.filename,
		status: source.status,
		page_count: source.pageCount,
		has_native_text: source.hasNativeText,
		layout_available: layoutAvailable,
		page_image_count: pageImageCount,
		source_language: hints?.source_language ?? readSourceMetadataLanguage(source),
		sensitivity_level: hints?.sensitivity_level ?? source.sensitivityLevel ?? 'internal',
		quality_hint: hints?.quality_hint ?? null,
		credibility_hint: hints?.credibility_hint ?? null,
		collection_hint: hints?.collection_hint ?? null,
		provenance_hint: hints?.provenance_hint ?? null,
		created_at: toIsoString(source.createdAt),
		updated_at: toIsoString(source.updatedAt),
		links: buildDocumentLinks(source.id),
	};
}

function readRecord(value: unknown): Record<string, unknown> {
	return unknownToJsonRecord(value);
}

function mapSourceSensitivity(source: Source): DocumentDetailResponse['data']['sensitivity'] {
	return {
		level: source.sensitivityLevel ?? 'internal',
		metadata: readRecord(source.sensitivityMetadata),
	};
}

function mapAcquisitionSummary(
	acquisition: Awaited<ReturnType<typeof listAcquisitionContextsForSource>>[number] | null,
): DocumentDetailResponse['data']['provenance'] {
	if (!acquisition) {
		return null;
	}

	return {
		context_id: acquisition.contextId,
		channel: acquisition.channel,
		submitted_at: acquisition.submittedAt.toISOString(),
		submitted_by_type: acquisition.submittedBy.type,
		collection_id: acquisition.collectionId,
		authenticity_status: acquisition.authenticityStatus,
		authenticity_notes: acquisition.authenticityNotes,
		submission_notes: acquisition.submissionNotes,
	};
}

function selectPrimaryAcquisition(
	acquisitions: Awaited<ReturnType<typeof listAcquisitionContextsForSource>>,
): Awaited<ReturnType<typeof listAcquisitionContextsForSource>>[number] | null {
	let fallback: Awaited<ReturnType<typeof listAcquisitionContextsForSource>>[number] | null = null;
	let active: Awaited<ReturnType<typeof listAcquisitionContextsForSource>>[number] | null = null;
	for (const acquisition of acquisitions) {
		fallback = acquisition;
		if (acquisition.status === 'active' || acquisition.status === 'restored') {
			active = acquisition;
		}
	}
	return active ?? fallback;
}

function mapOriginalSourceSummary(
	originalSource: Awaited<ReturnType<typeof findOriginalSourceForContext>>,
): DocumentDetailResponse['data']['original_source'] {
	if (!originalSource) {
		return null;
	}

	return {
		source_type: originalSource.sourceType,
		description: originalSource.sourceDescription,
		source_date: toIsoStringOrNull(originalSource.sourceDate),
		author: originalSource.sourceAuthor,
		language: originalSource.sourceLanguage,
		institution: originalSource.sourceInstitution,
		foia_reference: originalSource.foiaReference,
	};
}

function mapQualitySummary(
	quality: Awaited<ReturnType<typeof findLatestDocumentQualityAssessment>>,
): DocumentDetailResponse['data']['quality'] {
	if (!quality) {
		return null;
	}

	return {
		id: quality.id,
		assessed_at: quality.assessedAt.toISOString(),
		assessment_method: quality.assessmentMethod,
		overall_quality: quality.overallQuality,
		processable: quality.processable,
		recommended_path: quality.recommendedPath,
		text_readability_score: quality.dimensions.textReadability.score,
		language: quality.dimensions.languageDetection.primaryLanguage,
		language_confidence: quality.dimensions.languageDetection.confidence,
	};
}

function mapCollectionSummary(
	collection: Awaited<ReturnType<typeof summarizeCollection>>,
): DocumentDetailResponse['data']['collection'] {
	if (!collection) {
		return null;
	}

	return {
		id: collection.collectionId,
		name: collection.name,
		description: collection.description,
		type: collection.type,
		visibility: collection.visibility,
		tags: collection.tags,
		document_count: collection.documentCount,
		total_size_bytes: collection.totalSizeBytes,
		languages: collection.languages,
		date_range: {
			earliest: toIsoStringOrNull(collection.dateRange.earliest),
			latest: toIsoStringOrNull(collection.dateRange.latest),
		},
	};
}

function mapCredibilitySummary(
	credibility: Awaited<ReturnType<typeof findSourceCredibilityProfileBySourceId>>,
): DocumentDetailResponse['data']['credibility'] {
	if (!credibility) {
		return null;
	}

	const dimensionCount = credibility.dimensions.length;
	const averageScore =
		dimensionCount > 0
			? credibility.dimensions.reduce((total, dimension) => total + dimension.score, 0) / dimensionCount
			: null;

	return {
		profile_id: credibility.profileId,
		source_type: credibility.sourceType,
		profile_author: credibility.profileAuthor,
		review_status: credibility.reviewStatus,
		last_reviewed: toIsoStringOrNull(credibility.lastReviewed),
		dimension_count: dimensionCount,
		average_score: averageScore,
		sensitivity_level: credibility.sensitivityLevel,
	};
}

function readSourceMetadataLanguage(source: Source): string | null {
	const metadataLanguage =
		source.metadata.language ?? source.metadata.source_language ?? source.metadata.original_language;
	return typeof metadataLanguage === 'string' && metadataLanguage.trim().length > 0 ? metadataLanguage : null;
}

function resolveSourceLanguage(input: {
	originalSource: Awaited<ReturnType<typeof findOriginalSourceForContext>>;
	quality: Awaited<ReturnType<typeof findLatestDocumentQualityAssessment>>;
	source: Source;
}): string | null {
	return (
		input.originalSource?.sourceLanguage ??
		input.quality?.dimensions.languageDetection.primaryLanguage ??
		readSourceMetadataLanguage(input.source)
	);
}

function mapQualityHint(
	quality: Awaited<ReturnType<typeof findLatestDocumentQualityAssessment>>,
): DocumentListHints['quality_hint'] {
	if (!quality) {
		return null;
	}
	return {
		overall_quality: quality.overallQuality,
		processable: quality.processable,
		recommended_path: quality.recommendedPath,
		language: quality.dimensions.languageDetection.primaryLanguage,
	};
}

function mapCredibilityHint(
	credibility: Awaited<ReturnType<typeof findSourceCredibilityProfileBySourceId>>,
): DocumentListHints['credibility_hint'] {
	if (!credibility) {
		return null;
	}
	const averageScore =
		credibility.dimensions.length > 0
			? credibility.dimensions.reduce((total, dimension) => total + dimension.score, 0) / credibility.dimensions.length
			: null;
	return {
		review_status: credibility.reviewStatus,
		average_score: averageScore,
		sensitivity_level: credibility.sensitivityLevel,
	};
}

function mapCollectionHint(
	collection: Awaited<ReturnType<typeof summarizeCollection>>,
): DocumentListHints['collection_hint'] {
	if (!collection) {
		return null;
	}
	return {
		id: collection.collectionId,
		name: collection.name,
	};
}

function mapProvenanceHint(
	acquisition: Awaited<ReturnType<typeof listAcquisitionContextsForSource>>[number] | null,
): DocumentListHints['provenance_hint'] {
	if (!acquisition) {
		return null;
	}
	return {
		channel: acquisition.channel,
		submitted_at: acquisition.submittedAt.toISOString(),
		authenticity_status: acquisition.authenticityStatus,
		collection_id: acquisition.collectionId,
	};
}

function readNullableNumber(value: string | number | null): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === 'string') {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function createBaseListHint(source: Source): DocumentListHints {
	return {
		source_language: readSourceMetadataLanguage(source),
		sensitivity_level: source.sensitivityLevel ?? 'internal',
		quality_hint: null,
		credibility_hint: null,
		collection_hint: null,
		provenance_hint: null,
	};
}

async function loadDocumentListHints(
	pool: pg.Pool,
	sources: Source[],
	maxSensitivityLevel: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<Map<string, DocumentListHints>> {
	const hints = new Map(sources.map((source) => [source.id, createBaseListHint(source)]));
	if (sources.length === 0) {
		return hints;
	}

	const sourceIds = sources.map((source) => source.id);
	const credibilityParams: unknown[] = [sourceIds];
	const credibilitySensitivityClause = maxSensitivityLevel
		? `AND p.sensitivity_level = ANY($${credibilityParams.push(allowedSensitivityLevelsForMax(maxSensitivityLevel))})`
		: '';
	const [qualityResult, credibilityResult, provenanceResult] = await Promise.all([
		pool.query<DocumentQualityHintRow>(
			`
				SELECT DISTINCT ON (source_id)
					source_id,
					overall_quality,
					processable,
					recommended_path,
					COALESCE(
						dimensions #>> '{languageDetection,primaryLanguage}',
						dimensions #>> '{language_detection,primary_language}'
					) AS language
				FROM document_quality_assessments
				WHERE source_id = ANY($1::uuid[])
				ORDER BY source_id, assessed_at DESC, created_at DESC, id DESC
			`,
			[sourceIds],
		),
		pool.query<DocumentCredibilityHintRow>(
			`
				SELECT
					p.source_id,
					p.review_status,
					p.sensitivity_level,
					AVG(d.score)::double precision AS average_score
				FROM source_credibility_profiles p
				LEFT JOIN credibility_dimensions d ON d.profile_id = p.profile_id
				WHERE p.source_id = ANY($1::uuid[])
				${credibilitySensitivityClause}
				GROUP BY p.source_id, p.review_status, p.sensitivity_level
			`,
			credibilityParams,
		),
		pool.query<DocumentProvenanceHintRow>(
			`
				SELECT DISTINCT ON (ac.source_id)
					ac.source_id,
					ac.channel,
					ac.submitted_at,
					ac.authenticity_status,
					ac.collection_id,
					c.name AS collection_name,
					os.source_language
				FROM acquisition_contexts ac
				LEFT JOIN collections c ON c.collection_id = ac.collection_id
				LEFT JOIN original_sources os ON os.context_id = ac.context_id
				WHERE ac.source_id = ANY($1::uuid[])
				  AND ac.status IN ('active', 'restored')
				ORDER BY ac.source_id,
					CASE WHEN ac.status = 'active' THEN 0 ELSE 1 END,
					ac.submitted_at DESC,
					ac.context_id DESC
			`,
			[sourceIds],
		),
	]);

	for (const row of qualityResult.rows) {
		const hint = hints.get(row.source_id);
		if (!hint) continue;
		hint.quality_hint = {
			overall_quality: row.overall_quality,
			processable: row.processable,
			recommended_path: row.recommended_path,
			language: row.language,
		};
		hint.source_language ??= row.language;
	}

	for (const row of credibilityResult.rows) {
		const hint = hints.get(row.source_id);
		if (!hint) continue;
		hint.credibility_hint = {
			review_status: row.review_status,
			average_score: readNullableNumber(row.average_score),
			sensitivity_level: row.sensitivity_level,
		};
	}

	for (const row of provenanceResult.rows) {
		const hint = hints.get(row.source_id);
		if (!hint) continue;
		hint.provenance_hint = {
			channel: row.channel,
			submitted_at: row.submitted_at.toISOString(),
			authenticity_status: row.authenticity_status,
			collection_id: row.collection_id,
		};
		hint.collection_hint =
			row.collection_id && row.collection_name ? { id: row.collection_id, name: row.collection_name } : null;
		hint.source_language ??= row.source_language;
	}

	return hints;
}

function mapEntityForDocument(
	entity: Entity,
	input: { corpusSize: number; threshold: number },
): DocumentStoryResponse['entities'][number] {
	const corroboration = presentCorroborationScore(entity.corroborationScore, {
		corpusSize: input.corpusSize,
		threshold: input.threshold,
	});

	return {
		id: entity.id,
		canonical_id: entity.canonicalId,
		name: entity.name,
		type: entity.type,
		taxonomy_status: entity.taxonomyStatus,
		taxonomy_id: entity.taxonomyId,
		corroboration_score: corroboration.score,
		corroboration_status: corroboration.status,
		source_count: entity.sourceCount,
		attributes: entity.attributes ?? {},
		created_at: toIsoString(entity.createdAt),
		updated_at: toIsoString(entity.updatedAt),
	};
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMarkdown(markdown: string): string {
	return markdown
		.replace(/^#+\s+/gm, '')
		.replaceAll(/[*_`>#-]/g, '')
		.replaceAll(/\n+/g, ' ')
		.trim();
}

function excerptMarkdown(markdown: string): string {
	return stripMarkdown(markdown).slice(0, 200);
}

function buildStoragePath(prefix: string, sourceId: string, suffix: string): string {
	return `${prefix}/${sourceId}/${suffix}`;
}

function buildLayoutPath(sourceId: string): string {
	return buildStoragePath('extracted', sourceId, 'layout.md');
}

function buildPagePrefix(sourceId: string): string {
	return `${buildStoragePath('extracted', sourceId, 'pages')}/`;
}

function buildPagePath(sourceId: string, pageNumber: number): string {
	return `${buildPagePrefix(sourceId)}page-${String(pageNumber).padStart(3, '0')}.png`;
}

function sanitizeContentDispositionFilename(filename: string): string {
	let sanitized = '';
	for (const char of filename) {
		const code = char.charCodeAt(0);
		if (code < 32 || code === 127 || char === '\\') {
			sanitized += '_';
			continue;
		}

		if (char === '"') {
			sanitized += '\\"';
			continue;
		}

		sanitized += char;
	}

	sanitized = sanitized.trim();
	return sanitized.length > 0 ? sanitized : 'document.pdf';
}

function buildInlineContentDisposition(filename: string): string {
	return `inline; filename="${sanitizeContentDispositionFilename(filename)}"`;
}

function buildPdfArtifact(source: Source): DocumentArtifact {
	return {
		kind: 'pdf',
		source_id: source.id,
		storage_path: source.storagePath,
		content_type: PDF_CONTENT_TYPE,
		filename: source.filename,
	};
}

function buildLayoutArtifact(source: Source): DocumentArtifact {
	return {
		kind: 'layout',
		source_id: source.id,
		storage_path: buildLayoutPath(source.id),
		content_type: MARKDOWN_CONTENT_TYPE,
		filename: 'layout.md',
	};
}

function buildPageArtifact(sourceId: string, pageNumber: number): DocumentArtifact {
	return {
		kind: 'page_image',
		source_id: sourceId,
		storage_path: buildPagePath(sourceId, pageNumber),
		content_type: PNG_CONTENT_TYPE,
		filename: `page-${String(pageNumber).padStart(3, '0')}.png`,
		page_number: pageNumber,
	};
}

function getProjectionField(projection: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		const value = projection[key];
		if (value !== undefined && value !== null) {
			return value;
		}
	}

	return null;
}

function readProjectionString(projection: Record<string, unknown>, ...keys: string[]): string | null {
	const value = getProjectionField(projection, ...keys);
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProjectionNumber(projection: Record<string, unknown>, ...keys: string[]): number | null {
	const value = getProjectionField(projection, ...keys);
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readProjectionBoolean(projection: Record<string, unknown>, ...keys: string[]): boolean | null {
	const value = getProjectionField(projection, ...keys);
	return typeof value === 'boolean' ? value : null;
}

function readProjectionDateString(projection: Record<string, unknown>, ...keys: string[]): string | null {
	return readProjectionString(projection, ...keys);
}

function toIsoStringOrNull(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

interface DocumentObservabilitySourceProjection {
	status: string | null;
	extracted_at: string | null;
	segmented_at: string | null;
	page_count: number | null;
	story_count: number | null;
	vision_fallback_count: number | null;
	vision_fallback_capped: boolean | null;
}

interface DocumentObservabilityStoryProjection {
	status: string | null;
	enriched_at: string | null;
	embedded_at: string | null;
	graphed_at: string | null;
	entities_extracted: number | null;
	chunks_created: number | null;
}

interface DocumentObservabilityProgress {
	run_id: string;
	run_status: PipelineRun['status'];
	current_step: string;
	source_status: PipelineRunSource['status'];
	updated_at: string;
	error_message: string | null;
}

interface DocumentObservabilityStep {
	step: string;
	status: 'pending' | 'completed' | 'failed' | 'partial' | 'skipped';
	completed_at: string | null;
	error_message: string | null;
}

interface DocumentObservabilityTimelineEvent {
	scope: 'job' | 'source' | 'story';
	event: string;
	status: string;
	occurred_at: string;
	step: string | null;
	story_id: string | null;
	details: Record<string, unknown>;
}

interface DocumentObservabilityJob {
	job_id: string;
	status: Job['status'];
	attempts: number;
	max_attempts: number;
	error_log: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
}

const SOURCE_STEP_ORDER = new Map<string, number>(PIPELINE_STEP_VALUES.map((step, index) => [step, index]));

function sortSourceSteps(steps: SourceStep[]): SourceStep[] {
	return [...steps].sort((left, right) => {
		const leftIndex = SOURCE_STEP_ORDER.get(left.stepName) ?? Number.POSITIVE_INFINITY;
		const rightIndex = SOURCE_STEP_ORDER.get(right.stepName) ?? Number.POSITIVE_INFINITY;
		if (leftIndex !== rightIndex) {
			return leftIndex - rightIndex;
		}

		return left.stepName.localeCompare(right.stepName);
	});
}

function mapSourceStep(step: SourceStep): DocumentObservabilityStep {
	return {
		step: step.stepName,
		status: step.status,
		completed_at: toIsoStringOrNull(step.completedAt),
		error_message: step.errorMessage,
	};
}

function buildSourceProjection(
	projection: Record<string, unknown> | null,
): DocumentObservabilitySourceProjection | null {
	if (!projection) {
		return null;
	}

	return {
		status: readProjectionString(projection, 'status'),
		extracted_at: readProjectionDateString(projection, 'extractedAt', 'extracted_at'),
		segmented_at: readProjectionDateString(projection, 'segmentedAt', 'segmented_at'),
		page_count: readProjectionNumber(projection, 'pageCount', 'page_count'),
		story_count: readProjectionNumber(projection, 'storyCount', 'story_count'),
		vision_fallback_count: readProjectionNumber(projection, 'visionFallbackCount', 'vision_fallback_count'),
		vision_fallback_capped: readProjectionBoolean(projection, 'visionFallbackCapped', 'vision_fallback_capped'),
	};
}

function buildStoryProjection(projection: Record<string, unknown> | null): DocumentObservabilityStoryProjection | null {
	if (!projection) {
		return null;
	}

	return {
		status: readProjectionString(projection, 'status'),
		enriched_at: readProjectionDateString(projection, 'enrichedAt', 'enriched_at'),
		embedded_at: readProjectionDateString(projection, 'embeddedAt', 'embedded_at'),
		graphed_at: readProjectionDateString(projection, 'graphedAt', 'graphed_at'),
		entities_extracted: readProjectionNumber(projection, 'entitiesExtracted', 'entities_extracted'),
		chunks_created: readProjectionNumber(projection, 'chunksCreated', 'chunks_created'),
	};
}

function sortTimelineEvents(events: DocumentObservabilityTimelineEvent[]): DocumentObservabilityTimelineEvent[] {
	return [...events].sort((left, right) => {
		const timestampComparison = left.occurred_at.localeCompare(right.occurred_at);
		if (timestampComparison !== 0) {
			return timestampComparison;
		}

		const scopeComparison = left.scope.localeCompare(right.scope);
		if (scopeComparison !== 0) {
			return scopeComparison;
		}

		return left.event.localeCompare(right.event);
	});
}

function makeTimelineEvent(
	input: Omit<DocumentObservabilityTimelineEvent, 'details'> & { details?: Record<string, unknown> },
): DocumentObservabilityTimelineEvent {
	return {
		...input,
		details: input.details ?? {},
	};
}

function buildSourceTimelineEvents(
	sourceId: string,
	job: DocumentObservabilityJob | null,
	progress: DocumentObservabilityProgress | null,
	sourceProjection: DocumentObservabilitySourceProjection | null,
	steps: SourceStep[],
): DocumentObservabilityTimelineEvent[] {
	const events: DocumentObservabilityTimelineEvent[] = [];
	const currentStep = progress?.current_step ?? null;
	const progressUpdatedAt = progress?.updated_at ?? null;

	if (job) {
		events.push(
			makeTimelineEvent({
				scope: 'job',
				event: 'job.created',
				status: job.status,
				occurred_at: job.created_at,
				step: null,
				story_id: null,
				details: {
					job_id: job.job_id,
					attempts: job.attempts,
					max_attempts: job.max_attempts,
				},
			}),
		);

		if (job.started_at) {
			events.push(
				makeTimelineEvent({
					scope: 'job',
					event: 'job.started',
					status: job.status,
					occurred_at: job.started_at,
					step: currentStep,
					story_id: null,
					details: {
						job_id: job.job_id,
					},
				}),
			);
		}

		if (job.finished_at) {
			events.push(
				makeTimelineEvent({
					scope: 'job',
					event: 'job.finished',
					status: job.status,
					occurred_at: job.finished_at,
					step: currentStep,
					story_id: null,
					details: {
						job_id: job.job_id,
						error_log: job.error_log,
					},
				}),
			);
		}
	}

	if (progress && progressUpdatedAt) {
		events.push(
			makeTimelineEvent({
				scope: 'job',
				event: 'run.progress',
				status: progress.source_status,
				occurred_at: progressUpdatedAt,
				step: progress.current_step,
				story_id: null,
				details: {
					run_id: progress.run_id,
					source_id: sourceId,
					run_status: progress.run_status,
					error_message: progress.error_message,
				},
			}),
		);
	}

	for (const step of steps) {
		if (step.status === 'completed' && step.completedAt) {
			events.push(
				makeTimelineEvent({
					scope: 'source',
					event: 'source_step.completed',
					status: step.status,
					occurred_at: step.completedAt.toISOString(),
					step: step.stepName,
					story_id: null,
					details: {
						source_id: sourceId,
						origin: 'postgresql',
					},
				}),
			);
			continue;
		}

		if (step.status === 'failed') {
			const occurredAt = step.completedAt?.toISOString() ?? progressUpdatedAt;
			if (!occurredAt) {
				continue;
			}

			events.push(
				makeTimelineEvent({
					scope: 'source',
					event: 'source_step.failed',
					status: step.status,
					occurred_at: occurredAt,
					step: step.stepName,
					story_id: null,
					details: {
						source_id: sourceId,
						origin: 'postgresql',
						error_message: step.errorMessage,
					},
				}),
			);
		}

		if (step.status === 'skipped') {
			const occurredAt = step.completedAt?.toISOString() ?? progressUpdatedAt;
			if (!occurredAt) {
				continue;
			}

			events.push(
				makeTimelineEvent({
					scope: 'source',
					event: 'source_step.skipped',
					status: step.status,
					occurred_at: occurredAt,
					step: step.stepName,
					story_id: null,
					details: {
						source_id: sourceId,
						origin: 'postgresql',
					},
				}),
			);
		}
	}

	if (sourceProjection) {
		if (sourceProjection.extracted_at) {
			events.push(
				makeTimelineEvent({
					scope: 'source',
					event: 'source.projection.extracted',
					status: sourceProjection.status ?? 'unknown',
					occurred_at: sourceProjection.extracted_at,
					step: 'extract',
					story_id: null,
					details: {
						source_id: sourceId,
						projection: 'documents',
						field: 'extractedAt',
					},
				}),
			);
		}

		if (sourceProjection.segmented_at) {
			events.push(
				makeTimelineEvent({
					scope: 'source',
					event: 'source.projection.segmented',
					status: sourceProjection.status ?? 'unknown',
					occurred_at: sourceProjection.segmented_at,
					step: 'segment',
					story_id: null,
					details: {
						source_id: sourceId,
						projection: 'documents',
						field: 'segmentedAt',
					},
				}),
			);
		}
	}

	return events;
}

function buildStoryTimelineEvents(
	story: Story,
	projection: DocumentObservabilityStoryProjection | null,
): DocumentObservabilityTimelineEvent[] {
	if (!projection) {
		return [];
	}

	const events: DocumentObservabilityTimelineEvent[] = [];

	if (projection.enriched_at) {
		events.push(
			makeTimelineEvent({
				scope: 'story',
				event: 'story.projection.enriched',
				status: projection.status ?? story.status,
				occurred_at: projection.enriched_at,
				step: 'enrich',
				story_id: story.id,
				details: {
					projection: 'stories',
					field: 'enrichedAt',
				},
			}),
		);
	}

	if (projection.embedded_at) {
		events.push(
			makeTimelineEvent({
				scope: 'story',
				event: 'story.projection.embedded',
				status: projection.status ?? story.status,
				occurred_at: projection.embedded_at,
				step: 'embed',
				story_id: story.id,
				details: {
					projection: 'stories',
					field: 'embeddedAt',
				},
			}),
		);
	}

	if (projection.graphed_at) {
		events.push(
			makeTimelineEvent({
				scope: 'story',
				event: 'story.projection.graphed',
				status: projection.status ?? story.status,
				occurred_at: projection.graphed_at,
				step: 'graph',
				story_id: story.id,
				details: {
					projection: 'stories',
					field: 'graphedAt',
				},
			}),
		);
	}

	return events;
}

async function loadLatestJobForSource(pool: pg.Pool, sourceId: string): Promise<DocumentObservabilityJob | null> {
	const result = await pool.query<{
		id: string;
		status: Job['status'];
		attempts: number;
		max_attempts: number;
		error_log: string | null;
		created_at: Date;
		started_at: Date | null;
		finished_at: Date | null;
	}>(
		`
			SELECT id, status, attempts, max_attempts, error_log, created_at, started_at, finished_at
			FROM jobs
			WHERE COALESCE(payload->>'sourceId', payload->>'source_id') = $1
			ORDER BY created_at DESC, id DESC
			LIMIT 1
		`,
		[sourceId],
	);

	const row = result.rows[0];
	if (!row) {
		return null;
	}

	return {
		job_id: row.id,
		status: row.status,
		attempts: row.attempts,
		max_attempts: row.max_attempts,
		error_log: row.error_log,
		created_at: row.created_at.toISOString(),
		started_at: toIsoStringOrNull(row.started_at),
		finished_at: toIsoStringOrNull(row.finished_at),
	};
}

async function resolveObservabilityState(
	pool: pg.Pool,
	sourceId: string,
): Promise<{
	job: DocumentObservabilityJob | null;
	progress: DocumentObservabilityProgress | null;
}> {
	const [latestJob, latestRunSource] = await Promise.all([
		loadLatestJobForSource(pool, sourceId),
		findLatestPipelineRunSourceForSource(pool, sourceId),
	]);

	if (!latestRunSource) {
		return {
			job: latestJob,
			progress: null,
		};
	}

	const run = await findPipelineRunById(pool, latestRunSource.runId);
	if (!run) {
		return {
			job: latestJob,
			progress: null,
		};
	}

	return {
		job: latestJob,
		progress: {
			run_id: latestRunSource.runId,
			run_status: run.status,
			current_step: latestRunSource.currentStep,
			source_status: latestRunSource.status,
			updated_at: latestRunSource.updatedAt.toISOString(),
			error_message: latestRunSource.errorMessage,
		},
	};
}

async function buildDocumentObservabilityResponse(
	id: string,
	logger: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentObservabilityResponse> {
	const requestLogger = createRouteLogger(logger, {
		action: 'observability',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal);
	const source = await requireSource(pool, id, maxSensitivityLevel);

	const [sourceProjectionRecord, sourceSteps, stories, observabilityState] = await Promise.all([
		services.firestore.getDocument('documents', id),
		findSourceSteps(pool, id),
		findStoriesBySourceId(pool, id, { maxSensitivityLevel }),
		resolveObservabilityState(pool, id),
	]);

	const orderedSteps = sortSourceSteps(sourceSteps);
	const sourceProjection = buildSourceProjection(sourceProjectionRecord);
	const storyProjections = await Promise.all(
		stories.map(async (story) => {
			const projectionRecord = await services.firestore.getDocument('stories', story.id);
			return {
				story,
				projection: buildStoryProjection(projectionRecord),
			};
		}),
	);

	const job = observabilityState.job;
	const progress = observabilityState.progress;

	const timeline = sortTimelineEvents([
		...buildSourceTimelineEvents(source.id, job, progress, sourceProjection, orderedSteps),
		...storyProjections.flatMap(({ story, projection }) => buildStoryTimelineEvents(story, projection)),
	]);

	const response: DocumentObservabilityResponse = {
		data: {
			source: {
				id: source.id,
				filename: source.filename,
				status: source.status,
				page_count: source.pageCount,
				steps: orderedSteps.map(mapSourceStep),
				projection: sourceProjection,
			},
			stories: storyProjections.map(({ story, projection }) => ({
				id: story.id,
				title: story.title,
				status: story.status,
				page_start: story.pageStart,
				page_end: story.pageEnd,
				projection,
			})),
			job,
			progress,
			timeline,
		},
	};

	requestLogger.info(
		{
			story_count: response.data.stories.length,
			timeline_count: response.data.timeline.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document observability request completed',
	);

	return response;
}

function notFoundError(message: string, context: Record<string, unknown>): MulderError {
	return new MulderError(message, DOCUMENT_NOT_FOUND_CODE, { context });
}

async function requireSource(
	pool: pg.Pool,
	id: string,
	maxSensitivityLevel?: Source['sensitivityLevel'],
): Promise<Source> {
	const source = await findSourceById(pool, id, { maxSensitivityLevel });
	if (!source) {
		throw notFoundError(`Document not found: ${id}`, { id });
	}

	return source;
}

function parsePageNumberFromPath(path: string, sourceId: string): number | null {
	const pattern = new RegExp(`(?:^|/)${escapeRegExp(buildPagePrefix(sourceId))}page-(\\d+)\\.png$`);
	const match = pattern.exec(path);
	if (!match) {
		return null;
	}

	const pageNumber = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

async function listPageArtifacts(
	services: Services,
	sourceId: string,
): Promise<Array<Pick<DocumentPageItem, 'page_number' | 'image_url'>>> {
	const { paths } = await services.storage.list(buildPagePrefix(sourceId));
	return paths
		.map((path) => {
			const pageNumber = parsePageNumberFromPath(path, sourceId);
			if (!pageNumber) {
				return null;
			}

			return {
				page_number: pageNumber,
				image_url: `/api/documents/${sourceId}/pages/${pageNumber}`,
			};
		})
		.filter((page): page is Pick<DocumentPageItem, 'page_number' | 'image_url'> => page !== null)
		.sort((left, right) => left.page_number - right.page_number);
}

async function countPageArtifacts(services: Services, sourceId: string): Promise<number> {
	const pages = await listPageArtifacts(services, sourceId);
	return pages.length;
}

async function loadArtifactBytes(
	services: Services,
	artifact: DocumentArtifact,
	sourceId: string,
	artifactLabel: string,
): Promise<Buffer> {
	const exists = await services.storage.exists(artifact.storage_path);
	if (!exists) {
		throw notFoundError(`${artifactLabel} not found for document ${sourceId}`, {
			source_id: sourceId,
			artifact_kind: artifact.kind,
			storage_path: artifact.storage_path,
		});
	}

	return await services.storage.download(artifact.storage_path);
}

async function buildDocumentListResponse(
	input: DocumentListQuery,
	logger: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentListResponse> {
	const requestLogger = createRouteLogger(logger, {
		action: 'list',
		status: input.status ?? null,
		search: input.search ?? null,
		limit: input.limit,
		offset: input.offset,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal);
	const filter: SourceFilter = {
		status: input.status,
		search: input.search,
		limit: input.limit,
		offset: input.offset,
		maxSensitivityLevel,
	};
	const startedAt = performance.now();

	const [count, sources] = await Promise.all([countSources(pool, filter), findAllSources(pool, filter)]);
	const hints = await loadDocumentListHints(pool, sources, maxSensitivityLevel);
	const documents = await Promise.all(
		sources.map(async (source) => {
			const [layoutAvailable, pageImageCount] = await Promise.all([
				services.storage.exists(buildLayoutPath(source.id)),
				countPageArtifacts(services, source.id),
			]);

			return mapSourceToDocument(source, layoutAvailable, pageImageCount, hints.get(source.id));
		}),
	);

	const response: DocumentListResponse = {
		data: documents,
		meta: {
			count,
			limit: input.limit,
			offset: input.offset,
		},
	};

	requestLogger.info(
		{
			count,
			result_count: response.data.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document list request completed',
	);

	return response;
}

export async function listDocuments(
	input: DocumentListQuery,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentListResponse> {
	const rootLogger = logger ?? createLogger();
	return await buildDocumentListResponse(input, rootLogger, options);
}

export async function getDocumentDetail(
	id: string,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentDetailResponse> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'detail',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal);
	const source = await requireSource(pool, id, maxSensitivityLevel);
	const [layoutAvailable, pageImageCount, acquisitions, quality, credibility] = await Promise.all([
		services.storage.exists(buildLayoutPath(source.id)),
		countPageArtifacts(services, source.id),
		listAcquisitionContextsForSource(pool, source.id),
		findLatestDocumentQualityAssessment(pool, source.id),
		findSourceCredibilityProfileBySourceId(pool, source.id, { maxSensitivityLevel }),
	]);
	const acquisition = selectPrimaryAcquisition(acquisitions);
	const [originalSource, collection] = await Promise.all([
		acquisition ? findOriginalSourceForContext(pool, acquisition.contextId) : Promise.resolve(null),
		acquisition?.collectionId ? summarizeCollection(pool, acquisition.collectionId) : Promise.resolve(null),
	]);
	const sourceLanguage = resolveSourceLanguage({ originalSource, quality, source });
	const document = mapSourceToDocument(source, layoutAvailable, pageImageCount, {
		source_language: sourceLanguage,
		sensitivity_level: source.sensitivityLevel ?? 'internal',
		quality_hint: mapQualityHint(quality),
		credibility_hint: mapCredibilityHint(credibility),
		collection_hint: mapCollectionHint(collection),
		provenance_hint: mapProvenanceHint(acquisition),
	});
	const response: DocumentDetailResponse = {
		data: {
			...document,
			reader_link: `/sources/${source.id}`,
			provenance: mapAcquisitionSummary(acquisition),
			original_source: mapOriginalSourceSummary(originalSource),
			source_language: sourceLanguage,
			sensitivity: mapSourceSensitivity(source),
			quality: mapQualitySummary(quality),
			collection: mapCollectionSummary(collection),
			credibility: mapCredibilitySummary(credibility),
		},
	};

	requestLogger.info(
		{
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document detail request completed',
	);

	return response;
}

async function loadStoryMarkdown(services: Services, story: Story): Promise<string> {
	const exists = await services.storage.exists(story.gcsMarkdownUri);
	if (!exists) {
		throw notFoundError(`Story markdown not found for story ${story.id}`, {
			source_id: story.sourceId,
			story_id: story.id,
			storage_path: story.gcsMarkdownUri,
		});
	}

	const buffer = await services.storage.download(story.gcsMarkdownUri);
	return buffer.toString('utf-8');
}

export async function getDocumentStories(
	id: string,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentStoriesResponse> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'stories',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal);
	const source = await requireSource(pool, id, maxSensitivityLevel);
	const stories = await findStoriesBySourceId(pool, source.id, { maxSensitivityLevel });
	const corpusSize = await countProcessedSources(pool);
	const entityPresentation = {
		corpusSize,
		threshold: config.thresholds.corroboration_meaningful,
	};

	const responseStories = await Promise.all(
		stories.map(async (story): Promise<DocumentStoryResponse> => {
			const [markdown, entities] = await Promise.all([
				loadStoryMarkdown(services, story),
				findEntitiesByStoryId(pool, story.id, { maxSensitivityLevel }),
			]);

			return {
				id: story.id,
				source_id: story.sourceId,
				title: story.title,
				subtitle: story.subtitle,
				language: story.language,
				category: story.category,
				page_start: story.pageStart,
				page_end: story.pageEnd,
				extraction_confidence: story.extractionConfidence,
				status: story.status,
				markdown,
				excerpt: excerptMarkdown(markdown),
				entities: entities.map((entity) => mapEntityForDocument(entity, entityPresentation)),
			};
		}),
	);

	const response: DocumentStoriesResponse = {
		data: {
			source_id: source.id,
			stories: responseStories,
		},
		meta: {
			count: responseStories.length,
		},
	};

	requestLogger.info(
		{
			story_count: response.meta.count,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document stories request completed',
	);

	return response;
}

export async function getDocumentObservability(
	id: string,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentObservabilityResponse> {
	const rootLogger = logger ?? createLogger();
	return await buildDocumentObservabilityResponse(id, rootLogger, options);
}

export async function streamDocumentPdf(id: string, logger?: Logger, options?: RouteAccessOptions): Promise<Response> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'stream',
		artifact_kind: 'pdf',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const source = await requireSource(pool, id, resolveReadMaxSensitivity(config, options?.authPrincipal));
	const artifact = buildPdfArtifact(source);
	const buffer = await loadArtifactBytes(services, artifact, id, 'PDF');

	requestLogger.info(
		{
			filename: source.filename,
			byte_length: buffer.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document pdf request completed',
	);

	return new Response(buffer, {
		status: 200,
		headers: {
			'Content-Type': artifact.content_type,
			'Content-Disposition': buildInlineContentDisposition(source.filename),
		},
	});
}

export async function streamDocumentLayout(
	id: string,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<Response> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'stream',
		artifact_kind: 'layout',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const source = await requireSource(pool, id, resolveReadMaxSensitivity(config, options?.authPrincipal));
	const artifact = buildLayoutArtifact(source);
	const buffer = await loadArtifactBytes(services, artifact, id, 'layout.md');

	requestLogger.info(
		{
			filename: source.filename,
			byte_length: buffer.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document layout request completed',
	);

	return new Response(buffer, {
		status: 200,
		headers: {
			'Content-Type': artifact.content_type,
		},
	});
}

export async function listDocumentPages(
	id: string,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentPagesResponse> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'pages',
		artifact_kind: 'page_image',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	await requireSource(pool, id, resolveReadMaxSensitivity(config, options?.authPrincipal));
	const pages = await listPageArtifacts(services, id);

	const response: DocumentPagesResponse = {
		data: {
			source_id: id,
			pages,
		},
		meta: {
			count: pages.length,
		},
	};

	requestLogger.info(
		{
			result_count: response.data.pages.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document page list request completed',
	);

	return response;
}

export async function streamDocumentPage(
	id: string,
	pageNumber: number,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<Response> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'stream',
		artifact_kind: 'page_image',
		source_id: id,
		page_number: pageNumber,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const source = await requireSource(pool, id, resolveReadMaxSensitivity(config, options?.authPrincipal));
	const artifact = buildPageArtifact(source.id, pageNumber);
	const buffer = await loadArtifactBytes(services, artifact, id, `page ${pageNumber}`);

	requestLogger.info(
		{
			filename: source.filename,
			page_number: pageNumber,
			byte_length: buffer.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document page request completed',
	);

	return new Response(buffer, {
		status: 200,
		headers: {
			'Content-Type': artifact.content_type,
		},
	});
}

export function resetDocumentContextForTests(): void {
	cachedContext = null;
	cachedConfigPath = null;
}
