import { describe, expect, it } from 'vitest';
import { JobDetailResponseSchema, JobListResponseSchema } from './jobs.schemas.js';

describe('jobs schemas', () => {
	it('accepts document-centered job subjects in job lists', () => {
		const parsed = JobListResponseSchema.parse({
			data: [
				{
					id: '00000000-0000-4000-8000-000000000001',
					type: 'pipeline_run',
					subject: {
						kind: 'source',
						label: 'minutes.pdf',
						source_id: '00000000-0000-4000-8000-000000000002',
						source_count: 1,
					},
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					worker_id: null,
					created_at: '2026-05-14T10:00:00.000Z',
					started_at: '2026-05-14T10:01:00.000Z',
					finished_at: null,
					links: { self: '/api/jobs/00000000-0000-4000-8000-000000000001' },
				},
			],
			meta: { count: 1, limit: 20 },
		});

		expect(parsed.data[0].subject.label).toBe('minutes.pdf');
	});

	it('accepts visible source summaries on progress rows', () => {
		const parsed = JobDetailResponseSchema.parse({
			data: {
				job: {
					id: '00000000-0000-4000-8000-000000000001',
					type: 'pipeline_run',
					subject: { kind: 'batch', label: 'minutes.pdf + 1', source_count: 2 },
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					created_at: '2026-05-14T10:00:00.000Z',
					started_at: '2026-05-14T10:01:00.000Z',
					finished_at: null,
				},
				progress: {
					run_id: '00000000-0000-4000-8000-000000000003',
					run_status: 'running',
					source_counts: { pending: 0, processing: 1, completed: 0, failed: 0 },
					sources: [
						{
							source_id: '00000000-0000-4000-8000-000000000002',
							source: {
								id: '00000000-0000-4000-8000-000000000002',
								filename: 'minutes.pdf',
								status: 'ingested',
							},
							current_step: 'extract',
							status: 'processing',
							error_message: null,
							updated_at: '2026-05-14T10:02:00.000Z',
						},
					],
				},
			},
		});

		expect(parsed.data.progress?.sources[0].source?.filename).toBe('minutes.pdf');
	});
});
