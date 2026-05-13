import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError, apiFetch, buildApiUrl } from '@/lib/api-client';
import type {
	CompleteDocumentUploadRequest,
	CompleteDocumentUploadResponse,
	EnrichUploadProvenanceResponse,
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
	expected_sensitivity?: UploadExpectedSensitivityPayload;
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

interface PreparedUpload {
	contentType: string;
	initiated: InitiateDocumentUploadResponse;
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

async function uploadBinary(upload: InitiateDocumentUploadResponse['data']['upload'], file: File, contentType: string) {
	const uploadHeaders = new Headers(upload.headers);
	if (!uploadHeaders.has('Content-Type')) {
		uploadHeaders.set('Content-Type', contentType);
	}

	let uploadResponse: Response;
	try {
		uploadResponse = await fetch(buildApiUrl(upload.url), {
			body: file,
			credentials: upload.transport === 'dev_proxy' ? 'include' : 'omit',
			headers: uploadHeaders,
			method: upload.method,
		});
	} catch (error) {
		if (upload.transport === 'gcs_resumable') {
			// Some resumable GCS uploads complete but surface as browser fetch failures because
			// of the cross-origin upload response. The server-side complete step verifies the
			// object via storage metadata and reports the real failure if the object is absent.
			return;
		}
		throw error;
	}

	if (!uploadResponse.ok) {
		throw uploadError(uploadResponse);
	}
}

export function useDocumentUpload() {
	const queryClient = useQueryClient();
	const [rows, setRows] = useState<DocumentUploadRow[]>([]);
	const preparedUploads = useRef(new Map<string, PreparedUpload>());

	const updateRow = useCallback((rowId: string, patch: Partial<DocumentUploadRow>) => {
		setRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
	}, []);

	const prepareFile = useCallback(
		async (scopeKey: string, file: File, onInitiated?: () => void, forceNew = false): Promise<PreparedUpload> => {
			if (forceNew) {
				preparedUploads.current.delete(scopeKey);
			}
			const existing = preparedUploads.current.get(scopeKey);
			if (existing) return existing;

			const contentType = inferUploadContentType(file);
			const initiateBody: InitiateDocumentUploadRequest = {
				content_type: contentType,
				filename: file.name,
				size_bytes: file.size,
			};
			const initiated = await apiFetch<InitiateDocumentUploadResponse>('/api/uploads/documents/initiate', {
				body: JSON.stringify(initiateBody),
				method: 'POST',
			});
			onInitiated?.();
			await uploadBinary(initiated.data.upload, file, contentType);
			const prepared = { contentType, initiated };
			preparedUploads.current.set(scopeKey, prepared);
			return prepared;
		},
		[],
	);

	const enrichProvenance = useCallback(
		async (
			scopeKey: string,
			file: File,
			payload: DocumentUploadPayload,
			collectionId?: string | null,
		): Promise<EnrichUploadProvenanceResponse> => {
			const prepared = await prepareFile(scopeKey, file);
			return apiFetch<EnrichUploadProvenanceResponse>('/api/uploads/documents/enrich-provenance', {
				body: JSON.stringify({
					collection_id: collectionId ?? payload.provenance.acquisition?.collection_id ?? null,
					draft: {
						expected_sensitivity: payload.expected_sensitivity,
						provenance: payload.provenance,
					},
					filename: file.name,
					source_id: prepared.initiated.data.source_id,
					storage_path: prepared.initiated.data.storage_path,
				}),
				method: 'POST',
			});
		},
		[prepareFile],
	);

	const uploadRow = useCallback(
		async (row: DocumentUploadRow, payload: DocumentUploadPayload, options?: { forceNew?: boolean }) => {
			try {
				updateRow(row.id, { error: undefined, source: null, status: 'initiating' });
				const prepared = await prepareFile(
					row.id,
					row.file,
					() => updateRow(row.id, { status: 'uploading' }),
					options?.forceNew ?? false,
				);
				const initiated = prepared.initiated;

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
		[prepareFile, queryClient, updateRow],
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
			await uploadRow(row, payload, { forceNew: true });
		},
		[rows, uploadRow],
	);

	const reset = useCallback(() => {
		preparedUploads.current.clear();
		setRows([]);
	}, []);

	return {
		enrichProvenance,
		reset,
		retryRow,
		rows,
		uploadFiles,
	};
}
