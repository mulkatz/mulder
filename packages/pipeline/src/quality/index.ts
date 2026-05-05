import { performance } from 'node:perf_hooks';
import type {
	CompactDocumentQualitySummary,
	DocumentOverallQuality,
	DocumentQualityAssessment,
	DocumentQualityDimensions,
	DocumentQualityOverride,
	ExtractionPath,
	Logger,
	MulderConfig,
	Services,
	Source,
	SourceType,
} from '@mulder/core';
import {
	createChildLogger,
	createDocumentQualityAssessment,
	EXTRACT_ERROR_CODES,
	ExtractError,
	findLatestDocumentQualityAssessment,
	findSourceById,
	getStepConfigHash,
	normalizeDocumentQualityDimensions,
	normalizeDocumentQualitySignals,
	updateSource,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import type { QualityInput, QualityResult } from './types.js';

const STEP_NAME = 'quality';

const TEXT_LIKE_SOURCE_TYPES: readonly SourceType[] = ['text', 'docx', 'spreadsheet', 'email', 'url'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function readNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
	return typeof value === 'boolean' ? value : null;
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function pageCountForSource(source: Source, signals: Record<string, unknown>): number {
	return (
		readNumber(signals.pages_total) ??
		readNumber(signals.page_count) ??
		source.pageCount ??
		(source.sourceType === 'image' ? 1 : 0)
	);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function metadataSignals(source: Source): Record<string, unknown> {
	return {
		...source.formatMetadata,
		...source.metadata,
		source_type: source.sourceType,
		native_text_ratio: source.nativeTextRatio,
		has_native_text: source.hasNativeText,
		page_count: source.pageCount,
	};
}

function documentStructureForSource(
	sourceType: SourceType,
	signals: Record<string, unknown>,
): DocumentQualityDimensions['documentStructure'] {
	const configuredRecord = readRecord(signals.document_structure);
	const configured = readString(signals.document_structure) ?? readString(configuredRecord.type);
	const type =
		configured === 'table' ||
		configured === 'form' ||
		configured === 'handwritten' ||
		configured === 'mixed' ||
		configured === 'newspaper_clipping' ||
		configured === 'photo_of_document' ||
		configured === 'diagram' ||
		configured === 'printed_text'
			? configured
			: sourceType === 'spreadsheet'
				? 'table'
				: sourceType === 'email'
					? 'form'
					: sourceType === 'image'
						? 'photo_of_document'
						: 'printed_text';

	return {
		type,
		hasAnnotations: readBoolean(configuredRecord.has_annotations ?? signals.has_annotations) ?? false,
		hasMarginalia: readBoolean(configuredRecord.has_marginalia ?? signals.has_marginalia) ?? false,
		multiColumn: readBoolean(configuredRecord.multi_column ?? signals.multi_column) ?? false,
	};
}

function baseDimensions(input: {
	source: Source;
	signals: Record<string, unknown>;
	score: number;
	method: 'ocr_confidence' | 'llm_visual' | 'n/a';
	details: string;
}): DocumentQualityDimensions {
	const pagesTotal = pageCountForSource(input.source, input.signals);
	const pagesReadable = readNumber(input.signals.pages_readable) ?? pagesTotal;
	const imageIssues = stringArray(input.signals.image_quality_issues);
	const imageScore = readNumber(input.signals.image_quality_score) ?? (imageIssues.length > 0 ? 0.5 : 1);
	const language = readString(input.signals.primary_language) ?? readString(input.signals.language) ?? 'und';
	const languageConfidence = readNumber(input.signals.language_confidence) ?? (language === 'und' ? 0 : 1);

	return {
		textReadability: {
			score: clamp01(input.score),
			method: input.method,
			details: input.details,
		},
		imageQuality: {
			score: clamp01(imageScore),
			issues: imageIssues,
		},
		languageDetection: {
			primaryLanguage: language,
			confidence: clamp01(languageConfidence),
			mixedLanguages: readBoolean(input.signals.mixed_languages) ?? false,
		},
		documentStructure: documentStructureForSource(input.source.sourceType, input.signals),
		contentCompleteness: {
			pagesTotal,
			pagesReadable,
			missingPagesSuspected: readBoolean(input.signals.missing_pages_suspected) ?? false,
			truncated: readBoolean(input.signals.truncated) ?? false,
		},
	};
}

function isTextLike(sourceType: SourceType): boolean {
	return TEXT_LIKE_SOURCE_TYPES.some((candidate) => candidate === sourceType);
}

function routeForQuality(config: MulderConfig, quality: DocumentOverallQuality): ExtractionPath {
	return config.document_quality.routing[quality].path;
}

function scoreForQuality(quality: DocumentOverallQuality): number {
	switch (quality) {
		case 'high':
			return 1;
		case 'medium':
			return 0.7;
		case 'low':
			return 0.4;
		case 'unusable':
			return 0;
	}
}

function buildAutomatedAssessment(input: { source: Source; config: MulderConfig }): {
	overallQuality: DocumentOverallQuality;
	processable: boolean;
	recommendedPath: ExtractionPath;
	dimensions: DocumentQualityDimensions;
	signals: Record<string, unknown>;
} {
	const signals = metadataSignals(input.source);
	const source = input.source;

	if (isTextLike(source.sourceType)) {
		const dimensions = baseDimensions({
			source,
			signals,
			score: 1,
			method: 'n/a',
			details: 'prestructured source',
		});
		return {
			overallQuality: 'high',
			processable: true,
			recommendedPath: routeForQuality(input.config, 'high'),
			dimensions,
			signals,
		};
	}

	const pagesTotal = pageCountForSource(source, signals);
	const pagesReadable = readNumber(signals.pages_readable) ?? pagesTotal;
	const missingPages = readBoolean(signals.missing_pages_suspected) ?? false;
	const truncated = readBoolean(signals.truncated) ?? false;
	const nativeTextRatio = readNumber(signals.native_text_ratio) ?? source.nativeTextRatio;
	const ocrConfidence = readNumber(signals.ocr_confidence);
	const imageIssues = stringArray(signals.image_quality_issues);
	const unreadable = pagesTotal > 0 && pagesReadable <= 0;

	if (unreadable || (missingPages && truncated)) {
		const dimensions = baseDimensions({
			source,
			signals,
			score: 0,
			method: ocrConfidence === null ? 'n/a' : 'ocr_confidence',
			details: 'unreadable page signals',
		});
		return {
			overallQuality: 'unusable',
			processable: false,
			recommendedPath: routeForQuality(input.config, 'unusable'),
			dimensions,
			signals,
		};
	}

	if (source.sourceType === 'pdf') {
		if (nativeTextRatio >= input.config.document_quality.assessment.native_text_ratio_threshold) {
			const dimensions = baseDimensions({
				source,
				signals,
				score: nativeTextRatio,
				method: 'n/a',
				details: 'native text ratio above threshold',
			});
			return {
				overallQuality: 'high',
				processable: true,
				recommendedPath: routeForQuality(input.config, 'high'),
				dimensions,
				signals,
			};
		}

		if ((ocrConfidence ?? 0) >= input.config.document_quality.assessment.ocr_confidence_threshold) {
			const dimensions = baseDimensions({
				source,
				signals,
				score: ocrConfidence ?? 0,
				method: 'ocr_confidence',
				details: 'ocr confidence above threshold',
			});
			return {
				overallQuality: 'medium',
				processable: true,
				recommendedPath: routeForQuality(input.config, 'medium'),
				dimensions,
				signals,
			};
		}

		const dimensions = baseDimensions({
			source,
			signals,
			score: ocrConfidence ?? nativeTextRatio,
			method: ocrConfidence === null ? 'n/a' : 'ocr_confidence',
			details: 'weak native text and OCR signals',
		});
		return {
			overallQuality: 'low',
			processable: true,
			recommendedPath: routeForQuality(input.config, 'low'),
			dimensions,
			signals,
		};
	}

	const poorImage = imageIssues.length > 0 || (readNumber(signals.image_quality_score) ?? 1) < 0.4;
	const quality: DocumentOverallQuality = poorImage ? 'low' : 'medium';
	const dimensions = baseDimensions({
		source,
		signals,
		score: readNumber(signals.image_quality_score) ?? (poorImage ? 0.4 : 0.7),
		method: 'n/a',
		details: poorImage ? 'image quality warnings present' : 'image source defaults to visual extraction',
	});
	return {
		overallQuality: quality,
		processable: true,
		recommendedPath: routeForQuality(input.config, quality),
		dimensions,
		signals,
	};
}

function parseOverride(value: unknown): DocumentQualityOverride | null {
	if (!isRecord(value)) {
		return null;
	}

	const overallQuality = readString(value.overallQuality ?? value.overall_quality);
	const recommendedPath = readString(value.recommendedPath ?? value.recommended_path);
	const assessmentMethod = readString(value.assessmentMethod ?? value.assessment_method);
	const processable = readBoolean(value.processable);

	const override: DocumentQualityOverride = {};
	if (assessmentMethod === 'automated' || assessmentMethod === 'human') {
		override.assessmentMethod = assessmentMethod;
	}
	if (
		overallQuality === 'high' ||
		overallQuality === 'medium' ||
		overallQuality === 'low' ||
		overallQuality === 'unusable'
	) {
		override.overallQuality = overallQuality;
	}
	if (
		recommendedPath === 'standard' ||
		recommendedPath === 'enhanced_ocr' ||
		recommendedPath === 'visual_extraction' ||
		recommendedPath === 'handwriting_recognition' ||
		recommendedPath === 'manual_transcription_required' ||
		recommendedPath === 'skip'
	) {
		override.recommendedPath = recommendedPath;
	}
	if (processable !== null) {
		override.processable = processable;
	}
	if (value.dimensions !== undefined) {
		override.dimensions = normalizeDocumentQualityDimensions(value.dimensions);
	}
	if (value.signals !== undefined) {
		override.signals = normalizeDocumentQualitySignals(value.signals);
	}

	return Object.keys(override).length > 0 ? override : null;
}

function getDocumentQualityOverride(source: Source): DocumentQualityOverride | null {
	const formatOverride = parseOverride(source.formatMetadata.document_quality_override);
	const metadataOverride = parseOverride(source.metadata.document_quality_override);
	if (!formatOverride && !metadataOverride) {
		return null;
	}
	return {
		...(formatOverride ?? {}),
		...(metadataOverride ?? {}),
		signals: {
			...(formatOverride?.signals ?? {}),
			...(metadataOverride?.signals ?? {}),
		},
	};
}

function applyOverride(
	base: ReturnType<typeof buildAutomatedAssessment>,
	override: DocumentQualityOverride | null,
	source: Source,
	config: MulderConfig,
): ReturnType<typeof buildAutomatedAssessment> & { assessmentMethod: 'automated' | 'human' } {
	if (!override) {
		return { ...base, assessmentMethod: 'automated' };
	}

	const overallQuality = override.overallQuality ?? base.overallQuality;
	const recommendedPath = override.recommendedPath ?? routeForQuality(config, overallQuality);
	const processable =
		override.processable ??
		(recommendedPath === 'handwriting_recognition'
			? isTextLike(source.sourceType)
			: recommendedPath !== 'skip' && recommendedPath !== 'manual_transcription_required');

	return {
		overallQuality,
		processable,
		recommendedPath,
		dimensions: override.dimensions ? normalizeDocumentQualityDimensions(override.dimensions) : base.dimensions,
		signals: {
			...base.signals,
			...(override.signals ?? {}),
			override_applied: true,
		},
		assessmentMethod: override.assessmentMethod ?? 'human',
	};
}

export function buildCompactDocumentQualitySummary(
	assessment: DocumentQualityAssessment,
): CompactDocumentQualitySummary {
	const sourceQuality = assessment.overallQuality === 'unusable' ? 'low' : assessment.overallQuality;
	return {
		source_document_quality: sourceQuality,
		extraction_path: assessment.recommendedPath,
		extraction_confidence: scoreForQuality(assessment.overallQuality),
		document_quality_assessment_id: assessment.id,
	};
}

export function isAutomaticExtractionAllowed(input: {
	assessment: DocumentQualityAssessment;
	source: Source;
}): boolean {
	if (!input.assessment.processable) {
		return false;
	}
	if (
		input.assessment.recommendedPath === 'skip' ||
		input.assessment.recommendedPath === 'manual_transcription_required'
	) {
		return false;
	}
	if (input.assessment.recommendedPath === 'handwriting_recognition') {
		return input.assessment.processable;
	}
	return true;
}

async function propagateSourceQualitySummary(input: {
	pool: pg.Pool;
	source: Source;
	assessment: DocumentQualityAssessment;
	config: MulderConfig;
}): Promise<void> {
	if (!input.config.document_quality.quality_propagation.enabled) {
		return;
	}

	const summary = buildCompactDocumentQualitySummary(input.assessment);
	await updateSource(input.pool, input.source.id, {
		metadata: {
			...input.source.metadata,
			document_quality: summary,
		},
	});
}

export async function execute(
	input: QualityInput,
	config: MulderConfig,
	_services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<QualityResult> {
	const startTime = performance.now();
	const log = createChildLogger(logger, { step: STEP_NAME, sourceId: input.sourceId });
	const stepConfigHash = getStepConfigHash(config, STEP_NAME);

	if (!pool) {
		throw new ExtractError('Database pool is required for quality step', EXTRACT_ERROR_CODES.EXTRACT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	const source = await findSourceById(pool, input.sourceId);
	if (!source) {
		throw new ExtractError(`Source not found: ${input.sourceId}`, EXTRACT_ERROR_CODES.EXTRACT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	if (!config.document_quality.enabled) {
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: 'skipped',
			configHash: stepConfigHash,
		});
		return {
			status: 'skipped',
			data: null,
			errors: [],
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: 1,
				items_cached: 0,
			},
		};
	}

	const existing = await findLatestDocumentQualityAssessment(pool, input.sourceId);
	if (existing && !input.force) {
		await propagateSourceQualitySummary({ pool, source, assessment: existing, config });
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: 'completed',
			configHash: stepConfigHash,
		});
		return {
			status: 'success',
			data: { sourceId: input.sourceId, assessment: existing, reusedExisting: true },
			errors: [],
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: 0,
				items_cached: 1,
			},
		};
	}

	const base = buildAutomatedAssessment({ source, config });
	const assessmentInput = applyOverride(base, getDocumentQualityOverride(source), source, config);
	const assessment = await createDocumentQualityAssessment(pool, {
		sourceId: input.sourceId,
		assessmentMethod: assessmentInput.assessmentMethod,
		overallQuality: assessmentInput.overallQuality,
		processable: assessmentInput.processable,
		recommendedPath: assessmentInput.recommendedPath,
		dimensions: assessmentInput.dimensions,
		signals: assessmentInput.signals,
	});

	await propagateSourceQualitySummary({ pool, source, assessment, config });
	await upsertSourceStep(pool, {
		sourceId: input.sourceId,
		stepName: STEP_NAME,
		status: 'completed',
		configHash: stepConfigHash,
	});

	log.info(
		{
			assessmentId: assessment.id,
			overallQuality: assessment.overallQuality,
			recommendedPath: assessment.recommendedPath,
			processable: assessment.processable,
		},
		'Quality step completed',
	);

	return {
		status: 'success',
		data: { sourceId: input.sourceId, assessment, reusedExisting: false },
		errors: [],
		metadata: {
			duration_ms: Math.round(performance.now() - startTime),
			items_processed: 1,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}

export type { QualityData, QualityInput, QualityResult } from './types.js';
