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
import {
	ACTIVE_POLL_INTERVAL_MS,
	getRetryAfterDelayMs,
	INITIAL_POLL_INTERVAL_MS,
	jitterDelay,
	STABLE_POLL_INTERVAL_MS,
} from '@/lib/polling';

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

export type DocumentUploadFailedStep =
	| 'initiate'
	| 'binary_upload'
	| 'complete'
	| 'storage_verification'
	| 'finalization_poll'
	| 'pipeline_processing';

export type DocumentUploadRetryMode = 'restart' | 'check_status' | 'open_processing';

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
	failedStep?: DocumentUploadFailedStep;
	jobId?: string;
	pipelineRunId?: string | null;
	processingJobId?: string | null;
	retryMode?: DocumentUploadRetryMode;
	source?: UploadFinalizationStatusResponse['data']['source'];
	uploadStatusUrl?: string;
}

export function mapFinalizationToUploadRowPatch(
	finalization: UploadFinalizationStatusResponse,
): Pick<
	DocumentUploadRow,
	'failedStep' | 'jobId' | 'pipelineRunId' | 'processingJobId' | 'retryMode' | 'source' | 'status'
> & { error: undefined } {
	const resultStatus = finalization.data.result_status;
	const failed = resultStatus === 'failed' || resultStatus === 'dead_letter';
	return {
		error: undefined,
		failedStep: failed ? 'pipeline_processing' : undefined,
		jobId: finalization.data.job_id,
		pipelineRunId: finalization.data.pipeline?.run_id ?? null,
		processingJobId: finalization.data.pipeline?.job_id ?? null,
		retryMode: failed ? 'open_processing' : undefined,
		source: finalization.data.source,
		status: resultStatus === 'pending' ? 'processing' : resultStatus,
	};
}

interface PreparedUpload {
	contentType: string;
	initiated: InitiateDocumentUploadResponse;
}

const FINALIZATION_TIMEOUT_MS = 120_000;
const FINALIZATION_WALL_CLOCK_TIMEOUT_MS = 15 * 60_000;
const MAX_PARALLEL_UPLOADS = 2;

class UploadStepError extends Error {
	failedStep: DocumentUploadFailedStep;
	retryMode: DocumentUploadRetryMode;

	constructor(
		message: string,
		failedStep: DocumentUploadFailedStep,
		retryMode: DocumentUploadRetryMode,
		cause?: unknown,
	) {
		super(message);
		this.name = 'UploadStepError';
		this.failedStep = failedStep;
		this.retryMode = retryMode;
		this.cause = cause;
	}
}

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

function isStorageVerificationError(error: unknown) {
	return (
		error instanceof ApiError &&
		(error.code === 'UPLOAD_OBJECT_NOT_FOUND' ||
			error.code === 'UPLOAD_OBJECT_MISSING' ||
			error.code === 'UPLOAD_STORAGE_VERIFICATION_FAILED')
	);
}

function toUploadStepError(
	error: unknown,
	failedStep: DocumentUploadFailedStep,
	retryMode: DocumentUploadRetryMode,
	fallbackMessage: string,
) {
	if (error instanceof UploadStepError) return error;
	return new UploadStepError(error instanceof Error ? error.message : fallbackMessage, failedStep, retryMode, error);
}

async function runWithConcurrency<T>(items: T[], limit: number, run: (item: T) => Promise<unknown>) {
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (nextIndex < items.length) {
			const item = items[nextIndex] as T;
			nextIndex += 1;
			await run(item);
		}
	});
	await Promise.allSettled(workers);
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
			let initiated: InitiateDocumentUploadResponse;
			try {
				initiated = await apiFetch<InitiateDocumentUploadResponse>('/api/uploads/documents/initiate', {
					body: JSON.stringify(initiateBody),
					method: 'POST',
				});
			} catch (error) {
				throw toUploadStepError(error, 'initiate', 'restart', 'Upload could not be prepared.');
			}
			onInitiated?.();
			try {
				await uploadBinary(initiated.data.upload, file, contentType);
			} catch (error) {
				throw toUploadStepError(error, 'binary_upload', 'restart', 'File transfer could not be confirmed.');
			}
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

	const completeUpload = useCallback(async (completeBody: CompleteDocumentUploadRequest) => {
		try {
			return await apiFetch<CompleteDocumentUploadResponse>('/api/uploads/documents/complete', {
				body: JSON.stringify(completeBody),
				method: 'POST',
			});
		} catch (error) {
			if (isStorageVerificationError(error)) {
				throw toUploadStepError(
					error,
					'storage_verification',
					'restart',
					'The server could not verify the uploaded object.',
				);
			}
			throw toUploadStepError(error, 'complete', 'restart', 'Upload could not be completed.');
		}
	}, []);

	const pollFinalization = useCallback(
		async (rowId: string, uploadStatusUrl: string) => {
			const startedAt = Date.now();
			let countedWaitMs = 0;
			let pollDelayMs = INITIAL_POLL_INTERVAL_MS;
			let pendingCount = 0;

			while (countedWaitMs < FINALIZATION_TIMEOUT_MS && Date.now() - startedAt < FINALIZATION_WALL_CLOCK_TIMEOUT_MS) {
				let rateLimited = false;
				try {
					const finalization = await apiFetch<UploadFinalizationStatusResponse>(uploadStatusUrl);
					const resultStatus = finalization.data.result_status;
					if (resultStatus !== 'pending') {
						updateRow(rowId, mapFinalizationToUploadRowPatch(finalization));
						if (resultStatus === 'created' || resultStatus === 'duplicate') {
							void queryClient.invalidateQueries({ queryKey: ['documents'] });
						}
						return finalization;
					}
					pendingCount += 1;
					pollDelayMs = pendingCount >= 3 ? STABLE_POLL_INTERVAL_MS : ACTIVE_POLL_INTERVAL_MS;
				} catch (error) {
					if (error instanceof ApiError && error.status === 429) {
						rateLimited = true;
						pollDelayMs = getRetryAfterDelayMs(error);
					} else {
						throw toUploadStepError(
							error,
							'finalization_poll',
							'check_status',
							'Upload status could not be refreshed.',
						);
					}
				}
				const sleepMs = jitterDelay(pollDelayMs);
				await sleep(sleepMs);
				if (!rateLimited) {
					countedWaitMs += sleepMs;
				}
			}

			throw new UploadStepError('Upload finalization did not finish in time.', 'finalization_poll', 'check_status');
		},
		[queryClient, updateRow],
	);

	const uploadRow = useCallback(
		async (row: DocumentUploadRow, payload: DocumentUploadPayload, options?: { forceNew?: boolean }) => {
			try {
				updateRow(row.id, {
					error: undefined,
					failedStep: undefined,
					retryMode: undefined,
					source: null,
					status: 'initiating',
				});
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
				const completed = await completeUpload(completeBody);
				const uploadStatusUrl = completed.links.upload_status;
				if (!uploadStatusUrl) {
					throw new UploadStepError(
						'Upload completed, but the API did not return links.upload_status.',
						'complete',
						'restart',
					);
				}

				updateRow(row.id, {
					jobId: completed.data.job_id,
					failedStep: undefined,
					pipelineRunId: null,
					processingJobId: null,
					retryMode: undefined,
					status: 'processing',
					uploadStatusUrl,
				});

				return await pollFinalization(row.id, uploadStatusUrl);
			} catch (error) {
				const uploadError =
					error instanceof UploadStepError ? error : toUploadStepError(error, 'complete', 'restart', 'Upload failed.');
				updateRow(row.id, {
					error: uploadError.message,
					failedStep: uploadError.failedStep,
					retryMode: uploadError.retryMode,
					status: 'failed',
				});
				throw uploadError;
			}
		},
		[completeUpload, pollFinalization, prepareFile, updateRow],
	);

	const uploadFiles = useCallback(
		async (files: File[], payload: DocumentUploadPayload) => {
			const nextRows = files.map(createRow);
			setRows(nextRows);
			await runWithConcurrency(nextRows, MAX_PARALLEL_UPLOADS, (row) => uploadRow(row, payload));
		},
		[uploadRow],
	);

	const retryRow = useCallback(
		async (rowId: string, payload: DocumentUploadPayload) => {
			const row = rows.find((candidate) => candidate.id === rowId);
			if (!row) return;
			if (row.retryMode === 'check_status' && row.uploadStatusUrl) {
				updateRow(row.id, {
					error: undefined,
					failedStep: undefined,
					retryMode: undefined,
					status: 'processing',
				});
				await pollFinalization(row.id, row.uploadStatusUrl);
				return;
			}
			if (row.retryMode === 'open_processing') {
				return;
			}
			await uploadRow(row, payload, { forceNew: true });
		},
		[pollFinalization, rows, updateRow, uploadRow],
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
