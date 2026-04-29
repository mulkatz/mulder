import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { JobDetailResponse } from '@/lib/api-types';

export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ['jobs', 'detail', jobId],
    queryFn: () => apiFetch<JobDetailResponse>(`/api/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.data.job.status;
      return status === 'pending' || status === 'running' ? 1_000 : false;
    },
  });
}
