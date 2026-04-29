import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { JobListResponse, JobStatus } from '@/lib/api-types';

interface UseJobsOptions {
  status?: JobStatus;
  type?: string;
  limit?: number;
}

function buildJobsQuery(options: UseJobsOptions) {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 20));

  if (options.status) {
    params.set('status', options.status);
  }

  if (options.type) {
    params.set('type', options.type);
  }

  return `/api/jobs?${params.toString()}`;
}

export function useJobs(options: UseJobsOptions = {}) {
  return useQuery({
    queryKey: ['jobs', options],
    queryFn: () => apiFetch<JobListResponse>(buildJobsQuery(options)),
    refetchInterval: 3_000,
  });
}
