import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError, apiFetch, buildApiUrl } from '@/lib/api-client';
import type {
	CompleteDocumentUploadRequest,
	CompleteDocumentUploadResponse,
	InitiateDocumentUploadRequest,
	InitiateDocumentUploadResponse,
	UploadExpectedSensitivityPayload,
	UploadFinalizationStatusResponse,
	UploadProvenancePayload,
} from '@/lib/api-types';

export type DocumentUploadRowStatus =
	| 'ready'
	| 'initiating'
	| 'uploading'
	| 'finalizing'
	| 'processing'
	| 'created'
	| 'duplicate'
	| 'completed_unavailable'
	| 'failed'
	| 'dead_letter';

export interface DocumentUploadPayload {
	provenance: UploadProvenancePayload;
	expected_sensitivity: UploadExpectedSensitivityPayload;
	tags?: string[];
}

export interface DocumentUploadRow {
	id: string;
	file: File;
	status: DocumentUploadRowStatus;
	error?: string;
	jobId?: string;
	source?: UploadFinalizationStatusResponse['data']['source'];
	uploadStatusUrl?: string;
}

const FINALIZATION_POLL_INTERVAL_MS = 1500;
const FINALIZATION_TIMEOUT_MS = 120_000;

function createRow(file: File): DocumentUploadRow {
	return {
		id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${file.name}-${Date.now()}`,
		file,
		status: 'ready',
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function inferUploadContentType(file: File) {
	if (file.type.trim()) return file.type;
	const extension = file.name.split('.').pop()?.toLowerCase();
	switch (extension) {
		case 'pdf':
			return 'application/pdf';
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'tif':
		case 'tiff':
			return 'image/tiff';
		case 'md':
		case 'markdown':
			return 'text/markdown';
		case 'csv':
			return 'text/csv';
		case 'docx':
			return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
		case 'xlsx':
			return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		case 'eml':
			return 'message/rfc822';
		case 'msg':
			return 'application/vnd.ms-outlook';
		default:
			return 'text/plain';
	}
}

function uploadError(response: Response) {
	return new ApiError(response.status, 'UPLOAD_BINARY_FAILED', response.statusText || 'Upload failed');
}

export function useDocumentUpload() {
	const queryClient = useQueryClient();
	const [rows, setRows] = useState<DocumentUploadRow[]>([]);

	const updateRow = useCallback((rowId: string, patch: Partial<DocumentUploadRow>) => {
		setRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
	}, []);

	const uploadRow = useCallback(
		async (row: DocumentUploadRow, payload: DocumentUploadPayload) => {
			try {
				updateRow(row.id, { error: undefined, source: null, status: 'initiating' });
				const contentType = inferUploadContentType(row.file);
				const initiateBody: InitiateDocumentUploadRequest = {
					content_type: contentType,
					filename: row.file.name,
					size_bytes: row.file.size,
					tags: payload.tags,
				};
				const initiated = await apiFetch<InitiateDocumentUploadResponse>('/api/uploads/documents/initiate', {
					body: JSON.stringify(initiateBody),
					method: 'POST',
				});

				updateRow(row.id, { status: 'uploading' });
				const uploadHeaders = new Headers(initiated.data.upload.headers);
				if (!uploadHeaders.has('Content-Type')) {
					uploadHeaders.set('Content-Type', contentType);
				}
				const uploadResponse = await fetch(buildApiUrl(initiated.data.upload.url), {
					body: row.file,
					credentials: initiated.data.upload.transport === 'dev_proxy' ? 'include' : 'omit',
					headers: uploadHeaders,
					method: initiated.data.upload.method,
				});
				if (!uploadResponse.ok) {
					throw uploadError(uploadResponse);
				}

				updateRow(row.id, { status: 'finalizing' });
				const completeBody: CompleteDocumentUploadRequest = {
					expected_sensitivity: payload.expected_sensitivity,
					filename: row.file.name,
					provenance: payload.provenance,
					source_id: initiated.data.source_id,
					start_pipeline: true,
					storage_path: initiated.data.storage_path,
					tags: payload.tags,
				};
				const completed = await apiFetch<CompleteDocumentUploadResponse>('/api/uploads/documents/complete', {
					body: JSON.stringify(completeBody),
					method: 'POST',
				});
				const uploadStatusUrl = completed.links.upload_status;
				if (!uploadStatusUrl) {
					throw new ApiError(
						500,
						'UPLOAD_STATUS_MISSING',
						'Upload completed, but the API did not return links.upload_status.',
					);
				}

				updateRow(row.id, {
					jobId: completed.data.job_id,
					status: 'processing',
					uploadStatusUrl,
				});

				const startedAt = Date.now();
				while (Date.now() - startedAt < FINALIZATION_TIMEOUT_MS) {
					const finalization = await apiFetch<UploadFinalizationStatusResponse>(uploadStatusUrl);
					const resultStatus = finalization.data.result_status;
					if (resultStatus !== 'pending') {
						updateRow(row.id, {
							jobId: finalization.data.job_id,
							source: finalization.data.source,
							status: resultStatus,
						});
						if (resultStatus === 'created' || resultStatus === 'duplicate') {
							void queryClient.invalidateQueries({ queryKey: ['documents'] });
						}
						return finalization;
					}
					await sleep(FINALIZATION_POLL_INTERVAL_MS);
				}

				throw new ApiError(0, 'UPLOAD_FINALIZATION_TIMEOUT', 'Upload finalization did not finish in time.');
			} catch (error) {
				updateRow(row.id, {
					error: error instanceof Error ? error.message : 'Upload failed.',
					status: 'failed',
				});
				throw error;
			}
		},
		[queryClient, updateRow],
	);

	const uploadFiles = useCallback(
		async (files: File[], payload: DocumentUploadPayload) => {
			const nextRows = files.map(createRow);
			setRows(nextRows);
			await Promise.allSettled(nextRows.map((row) => uploadRow(row, payload)));
		},
		[uploadRow],
	);

	const retryRow = useCallback(
		async (rowId: string, payload: DocumentUploadPayload) => {
			const row = rows.find((candidate) => candidate.id === rowId);
			if (!row) return;
			await uploadRow(row, payload);
		},
		[rows, uploadRow],
	);

	const reset = useCallback(() => setRows([]), []);

	return {
		reset,
		retryRow,
		rows,
		uploadFiles,
	};
}
