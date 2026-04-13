/**
 * Type definitions for the job queue repository.
 *
 * Covers the `jobs` table and the queue-facing contracts shared by the
 * async API producer and worker consumer.
 *
 * @see docs/specs/67_job_queue_repository.spec.md §4.1
 * @see docs/functional-spec.md §4.3, §10.2, §10.3
 */

// ────────────────────────────────────────────────────────────
// Status enum
// ────────────────────────────────────────────────────────────

/** Lifecycle of a queued async job. */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';

/** Opaque JSONB payload carried by a job row. */
export type JobPayload = Record<string, unknown>;

// ────────────────────────────────────────────────────────────
// Job row
// ────────────────────────────────────────────────────────────

/** A job record from the database. */
export interface Job {
	id: string;
	type: string;
	payload: JobPayload;
	status: JobStatus;
	attempts: number;
	maxAttempts: number;
	errorLog: string | null;
	workerId: string | null;
	createdAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
}

/** Input for enqueueing a new job. */
export interface EnqueueJobInput {
	type: string;
	payload: JobPayload;
	maxAttempts?: number;
}

/** Filters for querying queue state. */
export interface JobFilter {
	type?: string;
	status?: JobStatus;
	workerId?: string;
	limit?: number;
	offset?: number;
}

/** Result of a dequeue attempt. */
export type DequeueJobResult = Job | null;

/** Summary returned by stale-job reaping. */
export interface ReapJobsResult {
	count: number;
	jobIds: string[];
}
