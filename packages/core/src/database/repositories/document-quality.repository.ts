import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import type {
	CreateDocumentQualityAssessmentInput,
	DocumentOverallQuality,
	DocumentQualityAssessment,
	DocumentQualityAssessmentMethod,
	DocumentQualityDimensions,
	DocumentQualitySignals,
	DocumentStructureType,
	ExtractionPath,
} from './document-quality.types.js';

type Queryable = pg.Pool | pg.PoolClient;

const ASSESSMENT_METHODS: readonly DocumentQualityAssessmentMethod[] = ['automated', 'human'] as const;
const OVERALL_QUALITIES: readonly DocumentOverallQuality[] = ['high', 'medium', 'low', 'unusable'] as const;
const EXTRACTION_PATHS: readonly ExtractionPath[] = [
	'standard',
	'enhanced_ocr',
	'visual_extraction',
	'handwriting_recognition',
	'manual_transcription_required',
	'skip',
] as const;
const DOCUMENT_STRUCTURE_TYPES: readonly DocumentStructureType[] = [
	'printed_text',
	'handwritten',
	'mixed',
	'table',
	'form',
	'newspaper_clipping',
	'photo_of_document',
	'diagram',
] as const;

interface DocumentQualityAssessmentRow {
	id: string;
	source_id: string;
	assessed_at: Date;
	assessment_method: DocumentQualityAssessmentMethod;
	overall_quality: DocumentOverallQuality;
	processable: boolean;
	recommended_path: ExtractionPath;
	dimensions: Record<string, unknown>;
	signals: Record<string, unknown>;
	created_at: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function readNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === 'string');
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function toDbDimensions(dimensions: DocumentQualityDimensions): Record<string, unknown> {
	return {
		text_readability: {
			score: dimensions.textReadability.score,
			method: dimensions.textReadability.method,
			details: dimensions.textReadability.details,
		},
		image_quality: {
			score: dimensions.imageQuality.score,
			issues: dimensions.imageQuality.issues,
		},
		language_detection: {
			primary_language: dimensions.languageDetection.primaryLanguage,
			confidence: dimensions.languageDetection.confidence,
			mixed_languages: dimensions.languageDetection.mixedLanguages,
		},
		document_structure: {
			type: dimensions.documentStructure.type,
			has_annotations: dimensions.documentStructure.hasAnnotations,
			has_marginalia: dimensions.documentStructure.hasMarginalia,
			multi_column: dimensions.documentStructure.multiColumn,
		},
		content_completeness: {
			pages_total: dimensions.contentCompleteness.pagesTotal,
			pages_readable: dimensions.contentCompleteness.pagesReadable,
			missing_pages_suspected: dimensions.contentCompleteness.missingPagesSuspected,
			truncated: dimensions.contentCompleteness.truncated,
		},
	};
}

export function normalizeDocumentQualityDimensions(value: unknown): DocumentQualityDimensions {
	const root = readObject(value);
	const text = readObject(root.textReadability ?? root.text_readability);
	const image = readObject(root.imageQuality ?? root.image_quality);
	const language = readObject(root.languageDetection ?? root.language_detection);
	const structure = readObject(root.documentStructure ?? root.document_structure);
	const completeness = readObject(root.contentCompleteness ?? root.content_completeness);

	return {
		textReadability: {
			score: readNumber(text.score, 0),
			method: enumValue(text.method, ['ocr_confidence', 'llm_visual', 'n/a'] as const, 'n/a'),
			details: readString(text.details, ''),
		},
		imageQuality: {
			score: readNumber(image.score, 1),
			issues: readStringArray(image.issues),
		},
		languageDetection: {
			primaryLanguage: readString(language.primaryLanguage ?? language.primary_language, 'und'),
			confidence: readNumber(language.confidence, 0),
			mixedLanguages: readBoolean(language.mixedLanguages ?? language.mixed_languages, false),
		},
		documentStructure: {
			type: enumValue(structure.type, DOCUMENT_STRUCTURE_TYPES, 'printed_text'),
			hasAnnotations: readBoolean(structure.hasAnnotations ?? structure.has_annotations, false),
			hasMarginalia: readBoolean(structure.hasMarginalia ?? structure.has_marginalia, false),
			multiColumn: readBoolean(structure.multiColumn ?? structure.multi_column, false),
		},
		contentCompleteness: {
			pagesTotal: readNumber(completeness.pagesTotal ?? completeness.pages_total, 0),
			pagesReadable: readNumber(completeness.pagesReadable ?? completeness.pages_readable, 0),
			missingPagesSuspected: readBoolean(
				completeness.missingPagesSuspected ?? completeness.missing_pages_suspected,
				false,
			),
			truncated: readBoolean(completeness.truncated, false),
		},
	};
}

export function normalizeDocumentQualitySignals(value: unknown): DocumentQualitySignals {
	return { ...readObject(value) };
}

function assertKnownEnum<T extends string>(value: T, allowed: readonly T[], field: string): void {
	if (!allowed.includes(value)) {
		throw new DatabaseError(`Invalid document quality ${field}: ${value}`, DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			context: { field, value },
		});
	}
}

function mapDocumentQualityAssessmentRow(row: DocumentQualityAssessmentRow): DocumentQualityAssessment {
	return {
		id: row.id,
		sourceId: row.source_id,
		assessedAt: row.assessed_at,
		assessmentMethod: row.assessment_method,
		overallQuality: row.overall_quality,
		processable: row.processable,
		recommendedPath: row.recommended_path,
		dimensions: normalizeDocumentQualityDimensions(row.dimensions),
		signals: normalizeDocumentQualitySignals(row.signals),
		createdAt: row.created_at,
	};
}

export async function createDocumentQualityAssessment(
	pool: Queryable,
	input: CreateDocumentQualityAssessmentInput,
): Promise<DocumentQualityAssessment> {
	assertKnownEnum(input.assessmentMethod, ASSESSMENT_METHODS, 'assessmentMethod');
	assertKnownEnum(input.overallQuality, OVERALL_QUALITIES, 'overallQuality');
	assertKnownEnum(input.recommendedPath, EXTRACTION_PATHS, 'recommendedPath');

	const sql = `
		INSERT INTO document_quality_assessments (
			source_id,
			assessed_at,
			assessment_method,
			overall_quality,
			processable,
			recommended_path,
			dimensions,
			signals
		)
		VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7, $8)
		RETURNING *
	`;

	try {
		const result = await pool.query<DocumentQualityAssessmentRow>(sql, [
			input.sourceId,
			input.assessedAt ?? null,
			input.assessmentMethod,
			input.overallQuality,
			input.processable,
			input.recommendedPath,
			JSON.stringify(toDbDimensions(input.dimensions)),
			JSON.stringify(input.signals ?? {}),
		]);
		return mapDocumentQualityAssessmentRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to create document quality assessment', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId },
		});
	}
}

export async function findLatestDocumentQualityAssessment(
	pool: Queryable,
	sourceId: string,
): Promise<DocumentQualityAssessment | null> {
	const sql = `
		SELECT *
		FROM document_quality_assessments
		WHERE source_id = $1
		ORDER BY assessed_at DESC, created_at DESC, id DESC
		LIMIT 1
	`;

	try {
		const result = await pool.query<DocumentQualityAssessmentRow>(sql, [sourceId]);
		return result.rows[0] ? mapDocumentQualityAssessmentRow(result.rows[0]) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find latest document quality assessment', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

export async function findDocumentQualityAssessmentById(
	pool: Queryable,
	id: string,
): Promise<DocumentQualityAssessment | null> {
	const sql = 'SELECT * FROM document_quality_assessments WHERE id = $1';

	try {
		const result = await pool.query<DocumentQualityAssessmentRow>(sql, [id]);
		return result.rows[0] ? mapDocumentQualityAssessmentRow(result.rows[0]) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find document quality assessment by id', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

export async function listDocumentQualityAssessmentsForSource(
	pool: Queryable,
	sourceId: string,
): Promise<DocumentQualityAssessment[]> {
	const sql = `
		SELECT *
		FROM document_quality_assessments
		WHERE source_id = $1
		ORDER BY assessed_at DESC, created_at DESC, id DESC
	`;

	try {
		const result = await pool.query<DocumentQualityAssessmentRow>(sql, [sourceId]);
		return result.rows.map(mapDocumentQualityAssessmentRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list document quality assessments', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}
