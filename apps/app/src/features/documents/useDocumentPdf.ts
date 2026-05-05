import { useQuery } from '@tanstack/react-query';
import { apiFetchBlob } from '@/lib/api-client';

const PDF_CACHE_TIME_MS = 10 * 60 * 1000;

export function useDocumentPdf(sourceId?: string) {
	return useQuery({
		queryKey: ['documents', sourceId, 'pdf'],
		queryFn: () =>
			apiFetchBlob(`/api/documents/${sourceId}/pdf`, {
				headers: { Accept: 'application/pdf' },
			}),
		enabled: Boolean(sourceId),
		gcTime: PDF_CACHE_TIME_MS,
		staleTime: Infinity,
	});
}
