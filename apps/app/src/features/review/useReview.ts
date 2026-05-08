import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
	ReviewActionRequest,
	ReviewActionResponse,
	ReviewArtifactDetailResponse,
	ReviewArtifactListResponse,
	ReviewEventListResponse,
	ReviewQueueListResponse,
	ReviewStatus,
} from '@/lib/api-types';

export interface ReviewArtifactFilters {
	reviewStatus?: ReviewStatus;
	limit?: number;
	offset?: number;
}

function buildReviewSearchParams(filters: ReviewArtifactFilters) {
	const params = new URLSearchParams();
	if (filters.reviewStatus) params.set('review_status', filters.reviewStatus);
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	if (filters.offset !== undefined) params.set('offset', String(filters.offset));
	return params.toString();
}

export function useReviewQueues() {
	return useQuery({
		queryFn: () => apiFetch<ReviewQueueListResponse>('/api/review/queues'),
		queryKey: ['review', 'queues'],
		staleTime: 30_000,
	});
}

export function useReviewQueueArtifacts(queueKey?: string, filters: ReviewArtifactFilters = {}) {
	return useQuery({
		enabled: Boolean(queueKey),
		queryFn: () => {
			const query = buildReviewSearchParams(filters);
			return apiFetch<ReviewArtifactListResponse>(
				`/api/review/queues/${queueKey}/artifacts${query ? `?${query}` : ''}`,
			);
		},
		queryKey: ['review', 'queues', queueKey, 'artifacts', filters],
		staleTime: 30_000,
	});
}

export function useReviewArtifact(artifactId?: string) {
	return useQuery({
		enabled: Boolean(artifactId),
		queryFn: () => apiFetch<ReviewArtifactDetailResponse>(`/api/review/artifacts/${artifactId}`),
		queryKey: ['review', 'artifacts', artifactId],
		staleTime: 30_000,
	});
}

export function useReviewArtifactEvents(
	artifactId?: string,
	filters: Pick<ReviewArtifactFilters, 'limit' | 'offset'> = {},
) {
	return useQuery({
		enabled: Boolean(artifactId),
		queryFn: () => {
			const query = buildReviewSearchParams(filters);
			return apiFetch<ReviewEventListResponse>(`/api/review/artifacts/${artifactId}/events${query ? `?${query}` : ''}`);
		},
		queryKey: ['review', 'artifacts', artifactId, 'events', filters],
		staleTime: 30_000,
	});
}

export function useRecordReviewAction(artifactId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: ReviewActionRequest) => {
			if (!artifactId) {
				throw new Error('artifactId is required to record a review action');
			}
			return apiFetch<ReviewActionResponse>(`/api/review/artifacts/${artifactId}/actions`, {
				body: JSON.stringify(request),
				method: 'POST',
			});
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['review'] });
		},
	});
}
