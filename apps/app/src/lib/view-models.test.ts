import { describe, expect, it } from 'vitest';
import type { JobSummary } from '@/lib/api-types';
import { jobToAnalysisRun } from './view-models';

function job(overrides: Partial<JobSummary> = {}): JobSummary {
	return {
		attempts: 1,
		created_at: '2026-05-15T12:00:00.000Z',
		finished_at: null,
		id: '00000000-0000-4000-8000-000000000123',
		links: { self: '/api/jobs/00000000-0000-4000-8000-000000000123' },
		max_attempts: 3,
		started_at: '2026-05-15T12:01:00.000Z',
		status: 'running',
		subject: {
			kind: 'source',
			label: 'CIQ_Issues_#13-24.pdf',
			source_id: '00000000-0000-4000-8000-000000000456',
		},
		type: 'pipeline_run',
		worker_id: 'worker-1',
		...overrides,
	};
}

describe('jobToAnalysisRun', () => {
	it('keeps the document label primary and localizes the job mode', () => {
		const run = jobToAnalysisRun(job(), {
			locale: 'de',
			t: ((key: string, options?: { defaultValue?: string }) => {
				if (key === 'jobType.pipeline_run') return 'Verarbeitungslauf';
				if (key === 'viewModel.pipelineQueue') return 'Pipeline-Warteschlange';
				if (key === 'viewModel.analysisRunQuery') return 'Verarbeitungsauftrag';
				if (key === 'viewModel.jobAccepted') return 'Angenommen';
				if (key === 'viewModel.jobAcceptedDetail') return 'Auftrag angenommen';
				if (key === 'viewModel.workerStarted') return 'Worker gestartet';
				if (key === 'viewModel.workerStartedDetail') return 'worker-1';
				return options?.defaultValue ?? key;
			}) as never,
		});

		expect(run.title).toBe('CIQ_Issues_#13-24.pdf');
		expect(run.mode).toBe('Verarbeitungslauf');
		expect(run.mode).not.toBe('pipeline_run');
	});
});
