import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { JobDetailResponse, JobListResponse } from '@/lib/api-types';

interface UseJobsOptions {
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
  type?: string;
  workerId?: string;
  limit?: number;
}

function buildJobsQuery(options: UseJobsOptions) {
  const params = new URLSearchParams();

  if (options.status) {
    params.set('status', options.status);
  }

  if (options.type) {
    params.set('type', options.type);
  }

  if (options.workerId) {
    params.set('worker_id', options.workerId);
  }

  params.set('limit', String(options.limit ?? 20));

  return `/api/jobs?${params.toString()}`;
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: ['jobs', 'detail', id],
    queryFn: () => apiFetch<JobDetailResponse>(`/api/jobs/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.data.job.status;
      if (!status || ['completed', 'failed', 'dead_letter'].includes(status)) {
        return false;
      }

      return 2000;
    },
  });
}

export function useJobs(options: UseJobsOptions = {}) {
  return useQuery({
    queryKey: ['jobs', 'list', options.status ?? null, options.type ?? null, options.workerId ?? null, options.limit ?? null],
    queryFn: () => apiFetch<JobListResponse>(buildJobsQuery(options)),
  });
}
