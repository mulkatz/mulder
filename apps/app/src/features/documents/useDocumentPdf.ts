import { useQuery } from '@tanstack/react-query';
import { apiFetchBlob } from '@/lib/api-client';

export function useDocumentPdf(sourceId?: string) {
	return useQuery({
		enabled: Boolean(sourceId),
		gcTime: 30 * 60 * 1000,
		queryFn: () => apiFetchBlob(`/api/documents/${sourceId}/pdf`),
		queryKey: ['documents', sourceId, 'pdf'],
		staleTime: Infinity,
	});
}
