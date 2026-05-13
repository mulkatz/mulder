import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { JobDetailResponse } from '@/lib/api-types';

export function useJob(jobId: string | undefined, options: { refetchInterval?: number | false } = {}) {
	return useQuery({
		queryKey: ['jobs', jobId],
		queryFn: () => apiFetch<JobDetailResponse>(`/api/jobs/${jobId}`),
		enabled: Boolean(jobId),
		refetchInterval: options.refetchInterval,
	});
}
