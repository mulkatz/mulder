import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	enqueueJob: vi.fn(),
}));

vi.mock('@mulder/core', () => ({
	budgetMonthStart: () => '2026-05',
	createMonthlyBudgetReservation: vi.fn(),
	createPipelineRun: vi.fn(async () => ({ id: 'run-1', tag: null })),
	enqueueJob: mocks.enqueueJob,
	estimateBudgetForSourceRun: vi.fn(() => ({ byStep: {}, totalUsd: 0 })),
	findLatestMonthlyBudgetReservationForSource: vi.fn(async () => null),
	findLatestPipelineRunSourceForSource: vi.fn(async () => ({
		currentStep: 'extract',
		runId: 'old-run',
		sourceId: 'source-1',
		status: 'failed',
	})),
	findSourceById: vi.fn(async () => ({
		fileHash: 'hash',
		formatMetadata: {},
		id: 'source-1',
		metadata: {},
		sourceType: 'pdf',
		status: 'extracted',
		storagePath: 'raw/source-1/original.pdf',
	})),
	getWorkerPool: vi.fn(() => ({
		connect: async () => ({
			query: async (sql: string) => (String(sql).includes('COUNT(*)') ? { rows: [{ count: '0' }] } : { rows: [] }),
			release: vi.fn(),
		}),
	})),
	isBudgetablePipelineStep: (step: string) => ['extract', 'segment', 'enrich', 'embed', 'graph'].includes(step),
	loadConfig: vi.fn(() => ({
		api: { budget: { enabled: false, monthly_limit_usd: 100 } },
		extraction: {},
		gcp: { cloud_sql: {} },
	})),
	PIPELINE_ERROR_CODES: {
		PIPELINE_BUDGET_EXCEEDED: 'PIPELINE_BUDGET_EXCEEDED',
		PIPELINE_INVALID_STEP_RANGE: 'PIPELINE_INVALID_STEP_RANGE',
		PIPELINE_RETRY_CONFLICT: 'PIPELINE_RETRY_CONFLICT',
		PIPELINE_SOURCE_NOT_FOUND: 'PIPELINE_SOURCE_NOT_FOUND',
		PIPELINE_WRONG_STATUS: 'PIPELINE_WRONG_STATUS',
	},
	PipelineError: class PipelineError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.code = code;
		}
	},
	planPipelineSteps: vi.fn(({ from = 'quality', upTo }: { from?: string; upTo?: string }) => {
		const order = ['quality', 'extract', 'segment', 'enrich', 'embed', 'graph'];
		const start = order.indexOf(from);
		const end = upTo ? order.indexOf(upTo) : order.length - 1;
		return { executableSteps: order.slice(start, end + 1), skippedSteps: [] };
	}),
	secondsUntilNextBudgetMonth: () => 1,
	summarizeMonthlyBudgetReservations: vi.fn(async () => ({ committedUsd: 0, reservedUsd: 0 })),
	upsertPipelineRunSource: vi.fn(),
	upsertSourceStep: vi.fn(),
}));

describe('pipeline job acceptance', () => {
	beforeEach(() => {
		mocks.enqueueJob.mockReset();
		mocks.enqueueJob.mockResolvedValue({ id: 'job-1', status: 'pending', type: 'pipeline_run' });
	});

	it('accepts pipeline runs as pipeline_run jobs', async () => {
		const { createPipelineRunJob } = await import('./pipeline-jobs.js');

		await createPipelineRunJob({ force: false, from: 'quality', source_id: 'source-1' });

		expect(mocks.enqueueJob).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				type: 'pipeline_run',
				payload: expect.objectContaining({ force: false, from: 'quality', sourceId: 'source-1' }),
			}),
		);
	});

	it('accepts retries as pipeline_run jobs from the failed step', async () => {
		const { createPipelineRetryJob } = await import('./pipeline-jobs.js');

		await createPipelineRetryJob({ source_id: 'source-1' });

		expect(mocks.enqueueJob).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				type: 'pipeline_run',
				payload: expect.objectContaining({ force: true, from: 'extract', sourceId: 'source-1' }),
			}),
		);
	});
});
