import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { JobListResponse, JobStatus } from '@/lib/api-types';
import { CONTENT_POLL_INTERVAL_MS, getRetryAfterDelayMs, STABLE_POLL_INTERVAL_MS } from '@/lib/polling';

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
		refetchInterval: (query) => {
			if (query.state.error) return getRetryAfterDelayMs(query.state.error, CONTENT_POLL_INTERVAL_MS);
			const data = query.state.data as JobListResponse | undefined;
			const hasOpenJobs = data?.data.some((job) => job.status === 'pending' || job.status === 'running') ?? false;
			return hasOpenJobs ? STABLE_POLL_INTERVAL_MS : false;
		},
		staleTime: 10_000,
	});
}
