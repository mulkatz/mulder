import { ApiError, apiFetch } from '@/lib/api-client';
import type { UploadCompleteResponse, UploadInitiateResponse } from '@/lib/api-types';

interface UploadCallbacks {
  onStage?: (stage: 'preparing' | 'uploading' | 'queued') => void;
}

function assertPdfFile(file: File) {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only PDF files can be uploaded.');
  }
}

async function uploadToTarget(file: File, url: string, headers: Record<string, string>, method: 'PUT') {
  const response = await fetch(url, {
    method,
    headers,
    body: file,
  });

  if (!response.ok) {
    throw new ApiError(response.status, 'UPLOAD_FAILED', 'The archive upload failed.');
  }
}

export function useUploadDocument() {
  return {
    uploadDocument: async (file: File, callbacks: UploadCallbacks = {}) => {
      assertPdfFile(file);
      callbacks.onStage?.('preparing');

      const initiate = await apiFetch<UploadInitiateResponse>('/api/uploads/documents/initiate', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          size_bytes: file.size,
          content_type: file.type || 'application/pdf',
        }),
      });

      callbacks.onStage?.('uploading');
      await uploadToTarget(
        file,
        initiate.data.upload.url,
        initiate.data.upload.headers,
        initiate.data.upload.method,
      );

      callbacks.onStage?.('queued');
      const complete = await apiFetch<UploadCompleteResponse>('/api/uploads/documents/complete', {
        method: 'POST',
        body: JSON.stringify({
          source_id: initiate.data.source_id,
          filename: file.name,
          storage_path: initiate.data.storage_path,
          start_pipeline: true,
        }),
      });

      return {
        sourceId: complete.data.source_id,
        jobId: complete.data.job_id,
        statusUrl: complete.links.status,
        maxBytes: initiate.data.limits.max_bytes,
      };
    },
  };
}
