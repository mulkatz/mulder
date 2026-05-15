import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api-client';
import type { JobListResponse } from '../../lib/api-types';
import { CONTENT_POLL_INTERVAL_MS, STABLE_POLL_INTERVAL_MS } from '../../lib/polling';
import { createJobsPollTracker, resolveJobsPollInterval } from './useJobs';

function jobsResponse(statuses: Array<'pending' | 'running' | 'completed'>): JobListResponse {
	return {
		data: statuses.map((status, index) => ({
			attempts: 0,
			created_at: '2026-05-14T00:00:00.000Z',
			finished_at: status === 'completed' ? '2026-05-14T00:01:00.000Z' : null,
			id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
			links: { self: `/api/jobs/00000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
			max_attempts: 3,
			started_at: status === 'pending' ? null : '2026-05-14T00:00:10.000Z',
			status,
			subject: { kind: 'source', label: `source-${index}.pdf`, source_count: 1 },
			type: 'pipeline_run',
			worker_id: null,
		})),
		meta: { count: statuses.length, limit: 25 },
	};
}

describe('resolveJobsPollInterval', () => {
	it('polls open jobs normally, slows after stable responses, and stops without open jobs', () => {
		const tracker = createJobsPollTracker();
		const data = jobsResponse(['running']);

		expect(resolveJobsPollInterval({ data, tracker })).toBe(STABLE_POLL_INTERVAL_MS);
		expect(resolveJobsPollInterval({ data, tracker })).toBe(STABLE_POLL_INTERVAL_MS);
		expect(resolveJobsPollInterval({ data, tracker })).toBe(STABLE_POLL_INTERVAL_MS);
		expect(resolveJobsPollInterval({ data, tracker })).toBe(CONTENT_POLL_INTERVAL_MS);
		expect(resolveJobsPollInterval({ data: jobsResponse(['completed']), tracker })).toBe(false);
	});

	it('uses Retry-After metadata for rate limits', () => {
		const tracker = createJobsPollTracker();
		const error = new ApiError(429, 'RATE_LIMITED', 'Slow down', undefined, { retryAfterMs: 30_000 });

		expect(resolveJobsPollInterval({ error, tracker })).toBe(30_000);
	});
});
