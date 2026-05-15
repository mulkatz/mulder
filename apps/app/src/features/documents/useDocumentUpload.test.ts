import { describe, expect, it } from 'vitest';
import type { UploadFinalizationStatusResponse } from '../../lib/api-types';
import { mapFinalizationToUploadRowPatch } from './useDocumentUpload';

function finalization(
	overrides: Partial<UploadFinalizationStatusResponse['data']> = {},
): UploadFinalizationStatusResponse {
	return {
		data: {
			created_at: '2026-05-14T00:00:00.000Z',
			finished_at: '2026-05-14T00:01:00.000Z',
			job_id: '11111111-1111-4111-8111-111111111111',
			job_status: 'completed',
			pipeline: {
				job_id: '22222222-2222-4222-8222-222222222222',
				links: {
					job: '/api/jobs/22222222-2222-4222-8222-222222222222',
				},
				run_id: '33333333-3333-4333-8333-333333333333',
			},
			requested_source_id: '44444444-4444-4444-8444-444444444444',
			result_status: 'created',
			source: {
				filename: 'case.pdf',
				id: '44444444-4444-4444-8444-444444444444',
				links: { document: '/api/documents/44444444-4444-4444-8444-444444444444' },
				status: 'ingested',
			},
			started_at: '2026-05-14T00:00:10.000Z',
			...overrides,
		},
		links: {
			job: '/api/jobs/11111111-1111-4111-8111-111111111111',
			source: '/api/documents/44444444-4444-4444-8444-444444444444',
		},
	};
}

describe('mapFinalizationToUploadRowPatch', () => {
	it('preserves finalization and pipeline job identifiers separately', () => {
		expect(mapFinalizationToUploadRowPatch(finalization())).toMatchObject({
			jobId: '11111111-1111-4111-8111-111111111111',
			pipelineRunId: '33333333-3333-4333-8333-333333333333',
			processingJobId: '22222222-2222-4222-8222-222222222222',
			retryMode: undefined,
			status: 'created',
		});
	});

	it('falls back to an open-processing retry mode for terminal failures', () => {
		expect(
			mapFinalizationToUploadRowPatch(
				finalization({
					job_status: 'failed',
					pipeline: null,
					result_status: 'failed',
					source: null,
				}),
			),
		).toMatchObject({
			failedStep: 'pipeline_processing',
			jobId: '11111111-1111-4111-8111-111111111111',
			processingJobId: null,
			retryMode: 'open_processing',
			status: 'failed',
		});
	});
});
