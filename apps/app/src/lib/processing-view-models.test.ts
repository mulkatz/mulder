import { describe, expect, it } from 'vitest';
import type { JobSummary } from '@/lib/api-types';
import {
	buildDocumentProcessingSteps,
	buildDocumentTranslationSteps,
	createDocumentProcessingGroups,
	DOCUMENT_PROCESSING_STEPS,
	findDocumentGroupForJob,
} from './processing-view-models';

function job(overrides: Partial<JobSummary> = {}): JobSummary {
	const id = overrides.id ?? '00000000-0000-4000-8000-000000000001';
	return {
		attempts: 1,
		created_at: '2026-05-15T12:00:00.000Z',
		finished_at: '2026-05-15T12:01:00.000Z',
		id,
		links: { self: `/api/jobs/${id}` },
		max_attempts: 3,
		started_at: '2026-05-15T12:00:05.000Z',
		status: 'completed',
		subject: {
			kind: 'source',
			label: 'document-a.pdf',
			source_id: '00000000-0000-4000-8000-000000000101',
		},
		type: 'document_upload_finalize',
		worker_id: null,
		...overrides,
	};
}

describe('processing document view models', () => {
	it('groups upload, pipeline and translation jobs for the same source into one document', () => {
		const groups = createDocumentProcessingGroups([
			job({ id: '00000000-0000-4000-8000-000000000011', type: 'document_upload_finalize' }),
			job({ id: '00000000-0000-4000-8000-000000000012', type: 'pipeline_run' }),
			job({ id: '00000000-0000-4000-8000-000000000013', type: 'translate' }),
			job({
				id: '00000000-0000-4000-8000-000000000014',
				subject: {
					kind: 'source',
					label: 'document-b.pdf',
					source_id: '00000000-0000-4000-8000-000000000202',
				},
				type: 'pipeline_run',
			}),
		]);

		expect(groups).toHaveLength(2);
		expect(groups.find((group) => group.title === 'document-a.pdf')?.jobs).toHaveLength(3);
		expect(groups.find((group) => group.title === 'document-b.pdf')?.jobs).toHaveLength(1);
	});

	it('coalesces jobs without source ids when the document label maps to one source', () => {
		const groups = createDocumentProcessingGroups([
			job({ id: '00000000-0000-4000-8000-000000000015', type: 'pipeline_run' }),
			job({
				id: '00000000-0000-4000-8000-000000000016',
				subject: {
					kind: 'source',
					label: 'document-a.pdf',
				},
				type: 'translate',
			}),
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].sourceId).toBe('00000000-0000-4000-8000-000000000101');
		expect(groups[0].jobs).toHaveLength(2);
	});

	it('prioritizes running, queued, failed and completed document statuses', () => {
		expect(
			createDocumentProcessingGroups([
				job({ type: 'pipeline_run', status: 'completed' }),
				job({ id: '00000000-0000-4000-8000-000000000021', type: 'translate', status: 'dead_letter' }),
			])[0].status,
		).toBe('failed');
		expect(
			createDocumentProcessingGroups([
				job({ type: 'pipeline_run', status: 'failed' }),
				job({ id: '00000000-0000-4000-8000-000000000022', type: 'translate', status: 'running' }),
			])[0].status,
		).toBe('running');
		expect(createDocumentProcessingGroups([job({ type: 'pipeline_run', status: 'pending' })])[0].status).toBe('queued');
	});

	it('never exposes pipeline_run as the current document step', () => {
		const group = createDocumentProcessingGroups([job({ type: 'pipeline_run', status: 'running' })])[0];

		expect(group.currentStep).toBe('processing');
		expect(group.currentStep).not.toBe('pipeline_run');
	});

	it('builds upload plus seven pipeline steps and keeps translations separate', () => {
		const group = createDocumentProcessingGroups([
			job({ type: 'document_upload_finalize' }),
			job({ id: '00000000-0000-4000-8000-000000000031', type: 'pipeline_run', status: 'running' }),
			job({ id: '00000000-0000-4000-8000-000000000032', type: 'translate', status: 'failed' }),
		])[0];
		const steps = buildDocumentProcessingSteps(group, {
			progressSource: {
				current_step: 'segment',
				error_message: null,
				source: {
					filename: 'document-a.pdf',
					id: '00000000-0000-4000-8000-000000000101',
					status: 'extracted',
				},
				source_id: '00000000-0000-4000-8000-000000000101',
				status: 'processing',
				updated_at: '2026-05-15T12:02:00.000Z',
			},
		});
		const translations = buildDocumentTranslationSteps(group);

		expect(steps.map((step) => step.name)).toEqual(DOCUMENT_PROCESSING_STEPS);
		expect(steps.find((step) => step.name === 'segment')?.status).toBe('running');
		expect(translations).toHaveLength(1);
		expect(translations[0].status).toBe('failed');
	});

	it('finds the document group for a job deep link', () => {
		const groups = createDocumentProcessingGroups([
			job({ id: '00000000-0000-4000-8000-000000000041', type: 'document_upload_finalize' }),
			job({ id: '00000000-0000-4000-8000-000000000042', type: 'pipeline_run' }),
		]);

		expect(findDocumentGroupForJob(groups, '00000000-0000-4000-8000-000000000042')?.title).toBe('document-a.pdf');
	});
});
