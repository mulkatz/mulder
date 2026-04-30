import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { JobListResponse, JobStatus } from '@/lib/api-types';

interface JobListOptions {
	status?: JobStatus | 'all';
	limit?: number;
}

function buildJobsQuery(options: JobListOptions = {}) {
	const params = new URLSearchParams();
	params.set('limit', String(options.limit ?? 25));
	if (options.status && options.status !== 'all') {
		params.set('status', options.status);
	}
	return `/api/jobs?${params.toString()}`;
}

export function useJobs(options: JobListOptions = {}) {
	return useQuery({
		queryKey: ['jobs', options],
		queryFn: () => apiFetch<JobListResponse>(buildJobsQuery(options)),
	});
}
