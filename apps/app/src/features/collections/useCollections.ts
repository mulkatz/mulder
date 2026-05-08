import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
	CollectionDetailResponse,
	CollectionListResponse,
	CollectionType,
	CollectionVisibility,
	CreateCollectionRequest,
	PatchCollectionRequest,
} from '@/lib/api-types';

export interface CollectionFilters {
	type?: CollectionType;
	visibility?: CollectionVisibility;
	archiveId?: string;
	tag?: string;
	limit?: number;
	offset?: number;
}

function buildCollectionSearchParams(filters: CollectionFilters) {
	const params = new URLSearchParams();
	if (filters.type) params.set('type', filters.type);
	if (filters.visibility) params.set('visibility', filters.visibility);
	if (filters.archiveId) params.set('archive_id', filters.archiveId);
	if (filters.tag) params.set('tag', filters.tag);
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	if (filters.offset !== undefined) params.set('offset', String(filters.offset));
	return params.toString();
}

export function useCollections(filters: CollectionFilters = {}) {
	return useQuery({
		queryFn: () => {
			const query = buildCollectionSearchParams(filters);
			return apiFetch<CollectionListResponse>(`/api/collections${query ? `?${query}` : ''}`);
		},
		queryKey: ['collections', filters],
		staleTime: 30_000,
	});
}

export function useCollection(collectionId?: string) {
	return useQuery({
		enabled: Boolean(collectionId),
		queryFn: () => apiFetch<CollectionDetailResponse>(`/api/collections/${collectionId}`),
		queryKey: ['collections', collectionId],
		staleTime: 30_000,
	});
}

export function useCreateCollection() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: CreateCollectionRequest) =>
			apiFetch<CollectionDetailResponse>('/api/collections', {
				body: JSON.stringify(request),
				method: 'POST',
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['collections'] });
		},
	});
}

export function usePatchCollection(collectionId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: PatchCollectionRequest) => {
			if (!collectionId) {
				throw new Error('collectionId is required to patch a collection');
			}
			return apiFetch<CollectionDetailResponse>(`/api/collections/${collectionId}`, {
				body: JSON.stringify(request),
				method: 'PATCH',
			});
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['collections'] });
		},
	});
}
