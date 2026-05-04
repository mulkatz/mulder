import { useQuery } from '@tanstack/react-query';
import { apiFetchText } from '@/lib/api-client';

export function useDocumentLayout(sourceId?: string) {
	return useQuery({
		queryKey: ['documents', sourceId, 'layout'],
		queryFn: () => apiFetchText(`/api/documents/${sourceId}/layout`),
		enabled: Boolean(sourceId),
	});
}
