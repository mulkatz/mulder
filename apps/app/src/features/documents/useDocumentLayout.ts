import { useQuery } from '@tanstack/react-query';
import { apiFetchText } from '@/lib/api-client';

export function useDocumentLayout(sourceId?: string, options: { refetchInterval?: number | false } = {}) {
	return useQuery({
		queryKey: ['documents', sourceId, 'layout'],
		queryFn: () => apiFetchText(`/api/documents/${sourceId}/layout`),
		enabled: Boolean(sourceId),
		refetchInterval: options.refetchInterval,
	});
}
