import { type Query, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { JobDetailResponse } from '@/lib/api-types';

type JobDetailQuery = Query<JobDetailResponse, Error, JobDetailResponse, readonly ['jobs', string | undefined]>;

export function useJob(
	jobId: string | undefined,
	options: { refetchInterval?: number | false | ((query: JobDetailQuery) => number | false | undefined) } = {},
) {
	return useQuery({
		queryKey: ['jobs', jobId],
		queryFn: () => apiFetch<JobDetailResponse>(`/api/jobs/${jobId}`),
		enabled: Boolean(jobId),
		refetchInterval: options.refetchInterval,
	});
}
