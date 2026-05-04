import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentListResponse } from '@/lib/api-types';

interface DocumentListOptions {
	limit?: number;
	offset?: number;
}

function buildDocumentsQuery(options: DocumentListOptions = {}) {
	const params = new URLSearchParams();
	params.set('limit', String(options.limit ?? 25));
	params.set('offset', String(options.offset ?? 0));
	return `/api/documents?${params.toString()}`;
}

export function useDocuments(options: DocumentListOptions = {}) {
	return useQuery({
		queryKey: ['documents', options],
		queryFn: () => apiFetch<DocumentListResponse>(buildDocumentsQuery(options)),
	});
}
