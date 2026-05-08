import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
	ClassificationMappingListResponse,
	ExternalCorrelationListResponse,
	SimilarEntityListResponse,
	TaxonomyMappingType,
	TemporalPatternListResponse,
} from '@/lib/api-types';

export interface PaginationFilters {
	limit?: number;
	offset?: number;
}

export interface SimilarEntityFilters extends PaginationFilters {
	entityId?: string;
}

export interface ClassificationMappingFilters extends PaginationFilters {
	taxonomyId?: string;
	categoryId?: string;
	sourceTaxonomyId?: string;
	sourceCategoryId?: string;
	targetTaxonomyId?: string;
	targetCategoryId?: string;
	mappingType?: TaxonomyMappingType;
	reviewStatus?: 'draft' | 'reviewed' | 'contested';
	minConfidence?: number;
}

export interface TemporalPatternFilters extends PaginationFilters {
	regionKey?: string;
	timeStart?: string;
	timeEnd?: string;
	reviewStatus?: 'pending' | 'approved' | 'rejected' | 'contested';
	signalStrength?: 'weak';
}

export interface ExternalCorrelationFilters extends PaginationFilters {
	internalSeriesKey?: string;
	externalSourceId?: string;
	externalSeriesId?: string;
	method?: 'spearman' | 'cross_correlation';
	timeStart?: string;
	timeEnd?: string;
	reviewStatus?: 'pending' | 'approved' | 'rejected' | 'contested';
	signalStrength?: 'weak';
}

function setPagination(params: URLSearchParams, filters: PaginationFilters) {
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	if (filters.offset !== undefined) params.set('offset', String(filters.offset));
}

function buildSimilarEntityParams(filters: SimilarEntityFilters) {
	const params = new URLSearchParams();
	if (filters.entityId) params.set('entity_id', filters.entityId);
	setPagination(params, filters);
	return params.toString();
}

function buildClassificationMappingParams(filters: ClassificationMappingFilters) {
	const params = new URLSearchParams();
	if (filters.taxonomyId) params.set('taxonomy_id', filters.taxonomyId);
	if (filters.categoryId) params.set('category_id', filters.categoryId);
	if (filters.sourceTaxonomyId) params.set('source_taxonomy_id', filters.sourceTaxonomyId);
	if (filters.sourceCategoryId) params.set('source_category_id', filters.sourceCategoryId);
	if (filters.targetTaxonomyId) params.set('target_taxonomy_id', filters.targetTaxonomyId);
	if (filters.targetCategoryId) params.set('target_category_id', filters.targetCategoryId);
	if (filters.mappingType) params.set('mapping_type', filters.mappingType);
	if (filters.reviewStatus) params.set('review_status', filters.reviewStatus);
	if (filters.minConfidence !== undefined) params.set('min_confidence', String(filters.minConfidence));
	setPagination(params, filters);
	return params.toString();
}

function buildTemporalParams(filters: TemporalPatternFilters) {
	const params = new URLSearchParams();
	if (filters.regionKey) params.set('region_key', filters.regionKey);
	if (filters.timeStart) params.set('time_start', filters.timeStart);
	if (filters.timeEnd) params.set('time_end', filters.timeEnd);
	if (filters.reviewStatus) params.set('review_status', filters.reviewStatus);
	if (filters.signalStrength) params.set('signal_strength', filters.signalStrength);
	setPagination(params, filters);
	return params.toString();
}

function buildExternalCorrelationParams(filters: ExternalCorrelationFilters) {
	const params = new URLSearchParams();
	if (filters.internalSeriesKey) params.set('internal_series_key', filters.internalSeriesKey);
	if (filters.externalSourceId) params.set('external_source_id', filters.externalSourceId);
	if (filters.externalSeriesId) params.set('external_series_id', filters.externalSeriesId);
	if (filters.method) params.set('method', filters.method);
	if (filters.timeStart) params.set('time_start', filters.timeStart);
	if (filters.timeEnd) params.set('time_end', filters.timeEnd);
	if (filters.reviewStatus) params.set('review_status', filters.reviewStatus);
	if (filters.signalStrength) params.set('signal_strength', filters.signalStrength);
	setPagination(params, filters);
	return params.toString();
}

export function useSimilarEntityLeads(filters: SimilarEntityFilters = {}) {
	return useQuery({
		enabled: Boolean(filters.entityId),
		queryFn: () => {
			const query = buildSimilarEntityParams(filters);
			return apiFetch<SimilarEntityListResponse>(`/api/discovery/similar-entities?${query}`);
		},
		queryKey: ['discovery', 'similar-entities', filters],
		staleTime: 60_000,
	});
}

export function useClassificationMappingLeads(filters: ClassificationMappingFilters = {}) {
	return useQuery({
		queryFn: () => {
			const query = buildClassificationMappingParams(filters);
			return apiFetch<ClassificationMappingListResponse>(
				`/api/discovery/classification-mappings${query ? `?${query}` : ''}`,
			);
		},
		queryKey: ['discovery', 'classification-mappings', filters],
		staleTime: 60_000,
	});
}

export function useTemporalPatternLeads(filters: TemporalPatternFilters = {}) {
	return useQuery({
		queryFn: () => {
			const query = buildTemporalParams(filters);
			return apiFetch<TemporalPatternListResponse>(`/api/discovery/temporal-patterns${query ? `?${query}` : ''}`);
		},
		queryKey: ['discovery', 'temporal-patterns', filters],
		staleTime: 60_000,
	});
}

export function useExternalCorrelationLeads(filters: ExternalCorrelationFilters = {}) {
	return useQuery({
		queryFn: () => {
			const query = buildExternalCorrelationParams(filters);
			return apiFetch<ExternalCorrelationListResponse>(
				`/api/discovery/external-correlations${query ? `?${query}` : ''}`,
			);
		},
		queryKey: ['discovery', 'external-correlations', filters],
		staleTime: 60_000,
	});
}
