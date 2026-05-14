import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { JobListResponse, JobStatus } from '@/lib/api-types';
import { CONTENT_POLL_INTERVAL_MS, getRetryAfterDelayMs, STABLE_POLL_INTERVAL_MS } from '@/lib/polling';

interface JobListOptions {
	status?: JobStatus | 'all';
	limit?: number;
}

function buildJobsQuery(options: JobListOptions = {}) {
	const params = new URLSearchParams();
	params.set('limit', String(options.limit ?? 25));
	if (options.status && options.status !== 'all') {
		params.set('status', options.status);
	}
	return `/api/jobs?${params.toString()}`;
}

export interface JobsPollTracker {
	signature: string;
	unchangedCount: number;
}

export function createJobsPollTracker(): JobsPollTracker {
	return { signature: '', unchangedCount: 0 };
}

function openJobsSignature(data: JobListResponse | undefined) {
	const openJobs = data?.data.filter((job) => job.status === 'pending' || job.status === 'running') ?? [];
	if (openJobs.length === 0) return null;
	return openJobs
		.map((job) => [job.id, job.status, job.started_at ?? '', job.finished_at ?? '', job.subject.label].join(':'))
		.join('|');
}

export function resolveJobsPollInterval(input: {
	data?: JobListResponse;
	error?: unknown;
	tracker: JobsPollTracker;
}): number | false {
	if (input.error) return getRetryAfterDelayMs(input.error, CONTENT_POLL_INTERVAL_MS);
	const signature = openJobsSignature(input.data);
	if (!signature) {
		input.tracker.signature = '';
		input.tracker.unchangedCount = 0;
		return false;
	}
	if (signature === input.tracker.signature) {
		input.tracker.unchangedCount += 1;
	} else {
		input.tracker.signature = signature;
		input.tracker.unchangedCount = 0;
	}
	return input.tracker.unchangedCount >= 3 ? CONTENT_POLL_INTERVAL_MS : STABLE_POLL_INTERVAL_MS;
}

export function useJobs(options: JobListOptions = {}) {
	const pollTrackerRef = useRef<JobsPollTracker>(createJobsPollTracker());
	return useQuery({
		queryKey: ['jobs', options],
		queryFn: () => apiFetch<JobListResponse>(buildJobsQuery(options)),
		refetchInterval: (query) => {
			return resolveJobsPollInterval({
				data: query.state.data as JobListResponse | undefined,
				error: query.state.error,
				tracker: pollTrackerRef.current,
			});
		},
		staleTime: 10_000,
	});
}
