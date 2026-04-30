import type {
	ContradictionRecord,
	DocumentListResponse,
	EvidenceSummaryResponse,
	JobDetailResponse,
	JobSummary,
	StatusResponse,
} from '@/lib/api-types';
import type { ActivityEvent, AnalysisRun, EvidenceClaim, Finding, Metric, RunStatus, Severity } from '@/lib/types';

const numberFormatter = new Intl.NumberFormat('en-US');

function formatNumber(value: number | null | undefined) {
	return typeof value === 'number' ? numberFormatter.format(value) : '—';
}

function formatDateTime(value: string | null | undefined) {
	if (!value) return 'Not started';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function formatClock(value: string | null | undefined) {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	return new Intl.DateTimeFormat('en-US', {
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function formatDuration(start: string | null | undefined, finish: string | null | undefined) {
	if (!start) return 'Not started';
	const startedAt = new Date(start).getTime();
	const finishedAt = finish ? new Date(finish).getTime() : Date.now();
	if (Number.isNaN(startedAt) || Number.isNaN(finishedAt) || finishedAt < startedAt) return 'Unknown';
	const totalSeconds = Math.round((finishedAt - startedAt) / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 1) return `${seconds}s`;
	return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function titleFromJobType(type: string) {
	return type
		.replaceAll('_', ' ')
		.replaceAll('-', ' ')
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function mapJobStatus(status: JobSummary['status']): RunStatus {
	if (status === 'pending') return 'queued';
	if (status === 'dead_letter') return 'failed';
	return status;
}

function progressFromJob(job: JobSummary | JobDetailResponse['data']['job']) {
	if (job.status === 'completed') return 100;
	if (job.status === 'pending') return 0;
	if ('progress' in job && job.progress) {
		const counts = job.progress.source_counts;
		const total = counts.pending + counts.processing + counts.completed + counts.failed;
		if (total > 0) return Math.round(((counts.completed + counts.failed) / total) * 100);
	}
	return null;
}

function timelineFromJob(job: JobSummary | JobDetailResponse['data']['job']) {
	const timeline: AnalysisRun['timeline'] = [
		{
			time: formatClock(job.created_at),
			label: 'Job accepted',
			detail: `Queue accepted ${job.type}.`,
			status: 'completed',
		},
	];

	if (job.started_at) {
		timeline.push({
			time: formatClock(job.started_at),
			label: 'Worker started',
			detail: job.worker_id ? `Worker ${job.worker_id} claimed the job.` : 'A worker claimed the job.',
			status: job.finished_at ? 'completed' : mapJobStatus(job.status),
		});
	}

	if ('progress' in job && job.progress) {
		for (const source of job.progress.sources.slice(0, 4)) {
			timeline.push({
				time: formatClock(source.updated_at),
				label: source.current_step,
				detail: source.error_message ?? source.source_id,
				status:
					source.status === 'processing'
						? 'running'
						: source.status === 'pending'
							? 'queued'
							: source.status === 'failed'
								? 'failed'
								: 'completed',
			});
		}
	}

	if (job.finished_at) {
		timeline.push({
			time: formatClock(job.finished_at),
			label: job.status === 'completed' ? 'Job completed' : 'Job stopped',
			detail: job.status === 'completed' ? 'Worker reported a completed job.' : 'Worker reported a terminal failure.',
			status: mapJobStatus(job.status),
		});
	}

	return timeline;
}

export function jobToAnalysisRun(job: JobSummary | JobDetailResponse['data']['job']): AnalysisRun {
	const payload = 'payload' in job ? job.payload : { type: job.type };
	const error = 'error_log' in job ? job.error_log : null;

	return {
		id: job.id,
		title: titleFromJobType(job.type),
		mode: job.type,
		status: mapJobStatus(job.status),
		owner: job.worker_id ?? 'Unassigned',
		corpus: 'Pipeline queue',
		startedAt: formatDateTime(job.started_at ?? job.created_at),
		duration: formatDuration(job.started_at, job.finished_at),
		attempts: `${job.attempts}/${job.max_attempts}`,
		credits: null,
		progress: progressFromJob(job),
		confidence: null,
		findings: null,
		query: 'Product-shaped analysis run summaries are not exposed yet. This view is backed by the jobs API.',
		params: payload,
		artifacts: [],
		timeline: timelineFromJob(job),
		error: error ?? undefined,
	};
}

export function jobsToActivity(jobs: JobSummary[]): ActivityEvent[] {
	return jobs.slice(0, 6).map((job) => ({
		id: `activity-${job.id}`,
		label: titleFromJobType(job.type),
		detail: job.worker_id ? `Worker ${job.worker_id}` : 'Waiting for worker assignment',
		time: formatDateTime(job.finished_at ?? job.started_at ?? job.created_at),
		status: mapJobStatus(job.status),
	}));
}

function contradictionSeverity(record: ContradictionRecord): Severity {
	if (record.edge_type === 'CONFIRMED_CONTRADICTION') return 'critical';
	if ((record.analysis?.confidence ?? record.confidence ?? 0) >= 0.75) return 'high';
	return 'medium';
}

export function contradictionsToFindings(records: ContradictionRecord[]): Finding[] {
	return records.slice(0, 5).map((record) => ({
		id: record.id,
		title:
			record.edge_type === 'CONFIRMED_CONTRADICTION'
				? 'Confirmed contradiction'
				: record.edge_type === 'DISMISSED_CONTRADICTION'
					? 'Dismissed contradiction'
					: 'Potential contradiction',
		summary: record.analysis?.explanation ?? `Relationship conflict on ${record.relationship}.`,
		severity: contradictionSeverity(record),
		entity: `${record.source_entity_id} -> ${record.target_entity_id}`,
		createdAt: record.story_id ?? 'No story link',
	}));
}

export function contradictionToClaim(record: ContradictionRecord): EvidenceClaim {
	const status =
		record.edge_type === 'CONFIRMED_CONTRADICTION'
			? 'contradicted'
			: record.edge_type === 'DISMISSED_CONTRADICTION'
				? 'unverified'
				: 'watching';
	const confidence = record.analysis?.confidence ?? record.confidence ?? 0;
	const attributeSignal = record.attributes.attribute
		? `Attribute: ${record.attributes.attribute}`
		: 'Attribute pending';
	const verdictSignal = record.analysis ? `Verdict: ${record.analysis.verdict}` : 'Needs review';

	return {
		id: record.id,
		claim: record.analysis?.explanation ?? `Contradiction candidate for ${record.relationship}.`,
		entity: `${record.source_entity_id} -> ${record.target_entity_id}`,
		status,
		confidence,
		lastSeen: record.story_id ?? 'No story link',
		sourceCount: 2,
		citations: [],
		signals: [attributeSignal, verdictSignal, record.relationship],
	};
}

export function buildOverviewMetrics({
	documents,
	evidence,
	status,
}: {
	documents?: DocumentListResponse;
	evidence?: EvidenceSummaryResponse;
	status?: StatusResponse;
}): Metric[] {
	const openContradictions = evidence
		? evidence.data.contradictions.potential + evidence.data.contradictions.confirmed
		: null;

	return [
		{
			label: 'Documents indexed',
			value: formatNumber(documents?.meta.count),
			delta: documents ? `${formatNumber(documents.data.length)} loaded` : 'API pending',
			tone: documents ? 'neutral' : 'warning',
		},
		{
			label: 'Entities resolved',
			value: formatNumber(evidence?.data.entities.total),
			delta: evidence ? `${formatNumber(evidence.data.entities.scored)} scored` : 'API pending',
			tone: evidence ? 'good' : 'warning',
		},
		{
			label: 'Open contradictions',
			value: formatNumber(openContradictions),
			delta: evidence ? `${formatNumber(evidence.data.contradictions.confirmed)} confirmed` : 'API pending',
			tone: openContradictions && openContradictions > 0 ? 'danger' : 'neutral',
		},
		{
			label: 'Queue running',
			value: formatNumber(status?.data.jobs.running),
			delta: status ? `${formatNumber(status.data.jobs.pending)} pending` : 'API pending',
			tone: status && status.data.jobs.failed + status.data.jobs.dead_letter > 0 ? 'warning' : 'neutral',
		},
	];
}
