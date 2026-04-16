import { buildApiUrl } from '@/lib/api-client';

export function usePdfUrl(id: string) {
  return buildApiUrl(`/api/documents/${id}/pdf`);
}
