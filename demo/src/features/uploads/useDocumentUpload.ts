import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, buildApiUrl } from '@/lib/api-client';
import type { CompleteUploadResponse, InitiateUploadResponse, JobDetailResponse } from '@/lib/api-types';

export interface UploadProgress {
  phase: 'validating' | 'uploading' | 'finalizing' | 'queued' | 'processing' | 'complete' | 'duplicate' | 'failed';
  message: string;
  jobId?: string;
  sourceId?: string;
  resolvedSourceId?: string;
}

interface UploadInput {
  file: File;
  tags?: string[];
  onProgress?: (progress: UploadProgress) => void;
}

function isTerminal(status: string) {
  return status === 'completed' || status === 'failed' || status === 'dead_letter';
}

async function waitForJob(jobId: string, onProgress?: (progress: UploadProgress) => void) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await apiFetch<JobDetailResponse>(`/api/jobs/${jobId}`);
    const { job } = response.data;

    if (job.status === 'pending') {
      onProgress?.({ phase: 'queued', message: 'Finalize job is queued.', jobId });
    } else if (job.status === 'running') {
      onProgress?.({ phase: 'processing', message: 'Worker is finalizing the upload.', jobId });
    }

    if (isTerminal(job.status)) {
      const resultStatus = job.payload.result_status;
      const resolvedSourceId = typeof job.payload.resolved_source_id === 'string' ? job.payload.resolved_source_id : undefined;
      if (job.status === 'completed' && resultStatus === 'duplicate') {
        return {
          phase: 'duplicate' as const,
          message: 'Duplicate detected. Opening the existing source.',
          jobId,
          resolvedSourceId,
        };
      }
      if (job.status === 'completed') {
        return {
          phase: 'complete' as const,
          message: 'Upload finalized. Pipeline worker has accepted the document.',
          jobId,
          resolvedSourceId,
        };
      }
      return {
        phase: 'failed' as const,
        message: job.error_log ?? 'Upload finalization failed.',
        jobId,
        resolvedSourceId,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return { phase: 'failed' as const, message: 'Timed out while waiting for the finalize job.', jobId };
}

export function useDocumentUpload() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ file, tags = [], onProgress }: UploadInput) => {
      onProgress?.({ phase: 'validating', message: 'Validating PDF upload request.' });
      const initiated = await apiFetch<InitiateUploadResponse>('/api/uploads/documents/initiate', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          size_bytes: file.size,
          content_type: file.type || 'application/pdf',
          tags,
        }),
      });

      onProgress?.({
        phase: 'uploading',
        message: 'Uploading PDF bytes through the configured local transport.',
        sourceId: initiated.data.source_id,
      });
      const uploadResponse = await fetch(buildApiUrl(initiated.data.upload.url), {
        method: initiated.data.upload.method,
        headers: initiated.data.upload.headers,
        body: file,
        credentials: 'include',
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed with ${uploadResponse.status}`);
      }

      onProgress?.({
        phase: 'finalizing',
        message: 'Creating finalize job.',
        sourceId: initiated.data.source_id,
      });
      const completed = await apiFetch<CompleteUploadResponse>('/api/uploads/documents/complete', {
        method: 'POST',
        body: JSON.stringify({
          source_id: initiated.data.source_id,
          filename: file.name,
          storage_path: initiated.data.storage_path,
          tags,
          start_pipeline: true,
        }),
      });

      const result = await waitForJob(completed.data.job_id, onProgress);
      const finalProgress = {
        ...result,
        sourceId: initiated.data.source_id,
      };
      onProgress?.(finalProgress);
      return finalProgress;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['evidence'] }),
        queryClient.invalidateQueries({ queryKey: ['status'] }),
      ]);
    },
  });
}
