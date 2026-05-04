import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ContradictionsResponse } from '@/lib/api-types';

export type ContradictionStatusFilter = 'potential' | 'confirmed' | 'dismissed' | 'all';

interface ContradictionOptions {
	status?: ContradictionStatusFilter;
	limit?: number;
	offset?: number;
}

function buildContradictionsQuery(options: ContradictionOptions = {}) {
	const params = new URLSearchParams();
	params.set('status', options.status ?? 'all');
	params.set('limit', String(options.limit ?? 25));
	params.set('offset', String(options.offset ?? 0));
	return `/api/evidence/contradictions?${params.toString()}`;
}

export function useContradictions(options: ContradictionOptions = {}) {
	return useQuery({
		queryKey: ['evidence', 'contradictions', options],
		queryFn: () => apiFetch<ContradictionsResponse>(buildContradictionsQuery(options)),
	});
}
