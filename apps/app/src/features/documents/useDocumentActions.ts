import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentActionResponse } from '@/lib/api-types';

function invalidateDocumentQueries(queryClient: ReturnType<typeof useQueryClient>, sourceId?: string) {
	void queryClient.invalidateQueries({ queryKey: ['jobs'] });
	void queryClient.invalidateQueries({ queryKey: ['documents'] });
	if (sourceId) {
		void queryClient.invalidateQueries({ queryKey: ['documents', sourceId] });
		void queryClient.invalidateQueries({ queryKey: ['documents', sourceId, 'detail'] });
		void queryClient.invalidateQueries({ queryKey: ['documents', sourceId, 'observability'] });
		void queryClient.invalidateQueries({ queryKey: ['documents', sourceId, 'stories'] });
		void queryClient.invalidateQueries({ queryKey: ['documents', sourceId, 'translations'] });
	}
}

export function useDeleteDocument(sourceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { reason: string }) => {
			if (!sourceId) throw new Error('sourceId is required to delete a document');
			return apiFetch<DocumentActionResponse>(`/api/documents/${sourceId}`, {
				body: JSON.stringify(input),
				method: 'DELETE',
			});
		},
		onSuccess: () => invalidateDocumentQueries(queryClient, sourceId),
	});
}

export function useRestoreDocument(sourceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => {
			if (!sourceId) throw new Error('sourceId is required to restore a document');
			return apiFetch<DocumentActionResponse>(`/api/documents/${sourceId}/restore`, { method: 'POST' });
		},
		onSuccess: () => invalidateDocumentQueries(queryClient, sourceId),
	});
}

export function useDocumentPurgePlan(sourceId?: string, enabled = false) {
	return useQuery({
		enabled: Boolean(sourceId) && enabled,
		queryFn: () => apiFetch<DocumentActionResponse>(`/api/documents/${sourceId}/purge-plan`),
		queryKey: ['documents', sourceId, 'purge-plan'],
		staleTime: 30_000,
	});
}

export function usePurgeDocument(sourceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { reason: string; confirm: boolean }) => {
			if (!sourceId) throw new Error('sourceId is required to purge a document');
			return apiFetch<DocumentActionResponse>(`/api/documents/${sourceId}/purge`, {
				body: JSON.stringify(input),
				method: 'POST',
			});
		},
		onSuccess: () => invalidateDocumentQueries(queryClient, sourceId),
	});
}
