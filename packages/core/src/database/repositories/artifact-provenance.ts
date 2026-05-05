/**
 * Shared provenance helpers for artifact repositories.
 *
 * Database JSONB uses the snake_case contract from functional spec §A6.1,
 * while repository objects expose camelCase fields.
 */

export interface ArtifactProvenance {
	sourceDocumentIds: string[];
	extractionPipelineRun: string | null;
	createdAt: Date;
}

export interface ArtifactProvenanceInput {
	sourceDocumentIds?: string[];
	extractionPipelineRun?: string | null;
	createdAt?: Date | string | null;
}

interface DatabaseArtifactProvenance {
	source_document_ids: string[];
	extraction_pipeline_run: string | null;
	created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSourceDocumentIds(sourceDocumentIds: readonly unknown[] | undefined): string[] {
	if (!sourceDocumentIds) {
		return [];
	}

	const unique = new Set<string>();
	for (const value of sourceDocumentIds) {
		if (typeof value !== 'string') {
			continue;
		}
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			unique.add(trimmed);
		}
	}

	return [...unique].sort();
}

function normalizeRunId(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCreatedAt(value: unknown): Date {
	if (value instanceof Date && !Number.isNaN(value.valueOf())) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.valueOf())) {
			return parsed;
		}
	}
	return new Date();
}

export function normalizeArtifactProvenance(input?: ArtifactProvenanceInput | null): ArtifactProvenance {
	return {
		sourceDocumentIds: normalizeSourceDocumentIds(input?.sourceDocumentIds),
		extractionPipelineRun: normalizeRunId(input?.extractionPipelineRun),
		createdAt: normalizeCreatedAt(input?.createdAt),
	};
}

export function provenanceForSource(sourceId: string | null | undefined, runId?: string | null): ArtifactProvenance {
	return normalizeArtifactProvenance({
		sourceDocumentIds: sourceId ? [sourceId] : [],
		extractionPipelineRun: runId ?? null,
	});
}

export function mapArtifactProvenanceFromDb(value: unknown): ArtifactProvenance {
	if (!isRecord(value)) {
		return normalizeArtifactProvenance();
	}

	const rawSourceIds = Array.isArray(value.source_document_ids) ? value.source_document_ids : [];
	return normalizeArtifactProvenance({
		sourceDocumentIds: rawSourceIds,
		extractionPipelineRun: normalizeRunId(value.extraction_pipeline_run),
		createdAt: typeof value.created_at === 'string' || value.created_at instanceof Date ? value.created_at : null,
	});
}

export function mapArtifactProvenanceToDb(input?: ArtifactProvenanceInput | null): DatabaseArtifactProvenance {
	const normalized = normalizeArtifactProvenance(input);
	return {
		source_document_ids: normalized.sourceDocumentIds,
		extraction_pipeline_run: normalized.extractionPipelineRun,
		created_at: normalized.createdAt.toISOString(),
	};
}

export function stringifyArtifactProvenance(input?: ArtifactProvenanceInput | null): string {
	return JSON.stringify(mapArtifactProvenanceToDb(input));
}

export function mergeArtifactProvenanceSql(currentRef: string, incomingRef: string): string {
	return `
		jsonb_build_object(
			'source_document_ids',
			(
				SELECT COALESCE(jsonb_agg(source_id ORDER BY source_id), '[]'::jsonb)
				FROM (
					SELECT DISTINCT source_id
					FROM jsonb_array_elements_text(COALESCE(${currentRef}->'source_document_ids', '[]'::jsonb)) AS existing(source_id)
					WHERE source_id <> ''
					UNION
					SELECT DISTINCT source_id
					FROM jsonb_array_elements_text(COALESCE(${incomingRef}->'source_document_ids', '[]'::jsonb)) AS incoming(source_id)
					WHERE source_id <> ''
				) provenance_source_ids
			),
			'extraction_pipeline_run',
			COALESCE(
				NULLIF(${currentRef}->'extraction_pipeline_run', 'null'::jsonb),
				NULLIF(${incomingRef}->'extraction_pipeline_run', 'null'::jsonb),
				'null'::jsonb
			),
			'created_at',
			COALESCE(
				NULLIF(${currentRef}->'created_at', 'null'::jsonb),
				NULLIF(${incomingRef}->'created_at', 'null'::jsonb),
				to_jsonb(now())
			)
		)
	`;
}
