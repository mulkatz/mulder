import {
	type DocumentQualityAssessment,
	findLatestDocumentQualityAssessment,
	findSourceById,
	findSourceCredibilityProfileBySourceId,
	listDocumentQualityAssessmentsForSource,
	listSourceCredibilityProfiles,
	MulderError,
	type SourceCredibilityProfile,
} from '@mulder/core';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	DocumentCredibilityResponse,
	DocumentQualityResponse,
	SourceCredibilityListQuery,
	SourceCredibilityListResponse,
} from '../routes/source-insights.schemas.js';
import { resolveApiDataContext, resolveReadMaxSensitivity } from './api-runtime.js';

interface SourceInsightRouteOptions {
	authPrincipal?: AuthPrincipal;
}

const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND';

async function requireReadableSource(
	sourceId: string,
	options?: SourceInsightRouteOptions,
): Promise<ReturnType<typeof resolveReadMaxSensitivity>> {
	const { config, pool } = resolveApiDataContext('source insights');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'source insights');
	const source = await findSourceById(pool, sourceId, { maxSensitivityLevel });
	if (!source) {
		throw new MulderError(`Document not found: ${sourceId}`, DOCUMENT_NOT_FOUND_CODE, { context: { id: sourceId } });
	}
	return maxSensitivityLevel;
}

function mapQualityAssessment(assessment: DocumentQualityAssessment) {
	return {
		id: assessment.id,
		source_id: assessment.sourceId,
		assessed_at: assessment.assessedAt.toISOString(),
		assessment_method: assessment.assessmentMethod,
		overall_quality: assessment.overallQuality,
		processable: assessment.processable,
		recommended_path: assessment.recommendedPath,
		dimensions: assessment.dimensions as unknown as Record<string, unknown>,
		signals: assessment.signals,
		created_at: assessment.createdAt.toISOString(),
	};
}

function mapCredibilityProfile(profile: SourceCredibilityProfile) {
	return {
		profile_id: profile.profileId,
		source_id: profile.sourceId,
		source_name: profile.sourceName,
		source_type: profile.sourceType,
		profile_author: profile.profileAuthor,
		last_reviewed: profile.lastReviewed?.toISOString() ?? null,
		review_status: profile.reviewStatus,
		provenance: profile.provenance as unknown as Record<string, unknown>,
		sensitivity_level: profile.sensitivityLevel,
		sensitivity_metadata: profile.sensitivityMetadata as unknown as Record<string, unknown>,
		dimensions: profile.dimensions.map((dimension) => ({
			id: dimension.id,
			profile_id: dimension.profileId,
			dimension_id: dimension.dimensionId,
			label: dimension.label,
			score: dimension.score,
			rationale: dimension.rationale,
			evidence_refs: dimension.evidenceRefs,
			known_factors: dimension.knownFactors,
			created_at: dimension.createdAt.toISOString(),
			updated_at: dimension.updatedAt.toISOString(),
		})),
		created_at: profile.createdAt.toISOString(),
		updated_at: profile.updatedAt.toISOString(),
	};
}

export async function getDocumentQuality(
	sourceId: string,
	options?: SourceInsightRouteOptions,
): Promise<DocumentQualityResponse> {
	const { pool } = resolveApiDataContext('source insights');
	await requireReadableSource(sourceId, options);
	const [latest, assessments] = await Promise.all([
		findLatestDocumentQualityAssessment(pool, sourceId),
		listDocumentQualityAssessmentsForSource(pool, sourceId),
	]);
	return {
		data: {
			latest: latest ? mapQualityAssessment(latest) : null,
			assessments: assessments.map(mapQualityAssessment),
		},
	};
}

export async function getDocumentCredibility(
	sourceId: string,
	options?: SourceInsightRouteOptions,
): Promise<DocumentCredibilityResponse> {
	const { pool } = resolveApiDataContext('source insights');
	const maxSensitivityLevel = await requireReadableSource(sourceId, options);
	const profile = await findSourceCredibilityProfileBySourceId(pool, sourceId, { maxSensitivityLevel });
	return {
		data: profile ? mapCredibilityProfile(profile) : null,
	};
}

export async function listSourceCredibility(
	query: SourceCredibilityListQuery,
	options?: SourceInsightRouteOptions,
): Promise<SourceCredibilityListResponse> {
	const { config, pool } = resolveApiDataContext('source insights');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'source credibility');
	const profiles = await listSourceCredibilityProfiles(pool, {
		sourceType: query.source_type,
		reviewStatus: query.review_status,
		maxSensitivityLevel,
		limit: query.limit,
		offset: query.offset,
	});
	return {
		data: profiles.map(mapCredibilityProfile),
		meta: {
			count: profiles.length,
			limit: query.limit,
			offset: query.offset,
		},
	};
}
