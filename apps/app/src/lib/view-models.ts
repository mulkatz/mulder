import type { TFunction } from 'i18next';
import { i18n } from '@/i18n';
import type {
	ContradictionRecord,
	DocumentListResponse,
	EvidenceSummaryResponse,
	JobDetailRecord,
	JobDetailResponse,
	JobProgress,
	JobSummary,
	StatusResponse,
} from '@/lib/api-types';
import type { ActivityEvent, AnalysisRun, EvidenceClaim, Finding, Metric, RunStatus, Severity } from '@/lib/types';

type JobForAnalysis = JobSummary | (JobDetailRecord & { progress?: JobProgress | null });

interface ViewModelContext {
	t: TFunction;
	locale: string;
}

function getContext(context?: Partial<ViewModelContext>): ViewModelContext {
	return {
		locale: context?.locale ?? i18n.language ?? 'en',
		t: context?.t ?? i18n.t.bind(i18n),
	};
}

function formatNumber(value: number | null | undefined, locale: string) {
	return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : '—';
}

function formatDateTime(value: string | null | undefined, context: ViewModelContext) {
	if (!value) return context.t('viewModel.notStarted');
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(context.locale, {
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function formatClock(value: string | null | undefined, locale: string) {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function formatDuration(
	start: string | null | undefined,
	finish: string | null | undefined,
	context: ViewModelContext,
) {
	if (!start) return context.t('viewModel.notStarted');
	const startedAt = new Date(start).getTime();
	const finishedAt = finish ? new Date(finish).getTime() : Date.now();
	if (Number.isNaN(startedAt) || Number.isNaN(finishedAt) || finishedAt < startedAt) return context.t('common.unknown');
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

function progressFromJob(job: JobForAnalysis) {
	if (job.status === 'completed') return 100;
	if (job.status === 'pending') return 0;
	if ('progress' in job && job.progress) {
		const counts = job.progress.source_counts;
		const total = counts.pending + counts.processing + counts.completed + counts.failed;
		if (total > 0) return Math.round(((counts.completed + counts.failed) / total) * 100);
	}
	return null;
}

function timelineFromJob(job: JobForAnalysis, context: ViewModelContext) {
	const timeline: AnalysisRun['timeline'] = [
		{
			time: formatClock(job.created_at, context.locale),
			label: context.t('viewModel.jobAccepted'),
			detail: context.t('viewModel.jobAcceptedDetail', { type: job.type }),
			status: 'completed',
		},
	];

	if (job.started_at) {
		timeline.push({
			time: formatClock(job.started_at, context.locale),
			label: context.t('viewModel.workerStarted'),
			detail: job.worker_id
				? context.t('viewModel.workerStartedDetail', { workerId: job.worker_id })
				: context.t('viewModel.workerStartedFallback'),
			status: job.finished_at ? 'completed' : mapJobStatus(job.status),
		});
	}

	if ('progress' in job && job.progress) {
		for (const source of job.progress.sources.slice(0, 4)) {
			timeline.push({
				time: formatClock(source.updated_at, context.locale),
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
			time: formatClock(job.finished_at, context.locale),
			label: job.status === 'completed' ? context.t('viewModel.jobCompleted') : context.t('viewModel.jobStopped'),
			detail:
				job.status === 'completed'
					? context.t('viewModel.jobCompletedDetail')
					: context.t('viewModel.jobStoppedDetail'),
			status: mapJobStatus(job.status),
		});
	}

	return timeline;
}

export function jobToAnalysisRun(job: JobForAnalysis, contextInput?: Partial<ViewModelContext>): AnalysisRun {
	const context = getContext(contextInput);
	const payload = 'payload' in job ? job.payload : { type: job.type };
	const error = 'error_log' in job ? job.error_log : null;

	return {
		id: job.id,
		title: titleFromJobType(job.type),
		mode: job.type,
		status: mapJobStatus(job.status),
		owner: job.worker_id ?? context.t('viewModel.unassigned'),
		corpus: context.t('viewModel.pipelineQueue'),
		startedAt: formatDateTime(job.started_at ?? job.created_at, context),
		duration: formatDuration(job.started_at, job.finished_at, context),
		attempts: `${job.attempts}/${job.max_attempts}`,
		credits: null,
		progress: progressFromJob(job),
		confidence: null,
		findings: null,
		query: context.t('viewModel.analysisRunQuery'),
		params: payload,
		artifacts: [],
		timeline: timelineFromJob(job, context),
		error: error ?? undefined,
	};
}

export function jobDetailToAnalysisRun(
	detail: JobDetailResponse['data'],
	contextInput?: Partial<ViewModelContext>,
): AnalysisRun {
	return jobToAnalysisRun(
		{
			...detail.job,
			progress: detail.progress,
		},
		contextInput,
	);
}

export function jobsToActivity(jobs: JobSummary[], contextInput?: Partial<ViewModelContext>): ActivityEvent[] {
	const context = getContext(contextInput);
	return jobs.slice(0, 6).map((job) => ({
		id: `activity-${job.id}`,
		label: titleFromJobType(job.type),
		detail: job.worker_id
			? context.t('viewModel.workerStartedDetail', { workerId: job.worker_id })
			: context.t('viewModel.waitingForWorker'),
		time: formatDateTime(job.finished_at ?? job.started_at ?? job.created_at, context),
		status: mapJobStatus(job.status),
	}));
}

function contradictionSeverity(record: ContradictionRecord): Severity {
	if (record.edge_type === 'CONFIRMED_CONTRADICTION') return 'critical';
	if ((record.analysis?.confidence ?? record.confidence ?? 0) >= 0.75) return 'high';
	return 'medium';
}

export function contradictionsToFindings(
	records: ContradictionRecord[],
	contextInput?: Partial<ViewModelContext>,
): Finding[] {
	const context = getContext(contextInput);
	return records.slice(0, 5).map((record) => ({
		id: record.id,
		title:
			record.edge_type === 'CONFIRMED_CONTRADICTION'
				? context.t('viewModel.confirmedContradiction')
				: record.edge_type === 'DISMISSED_CONTRADICTION'
					? context.t('viewModel.dismissedContradiction')
					: context.t('viewModel.potentialContradiction'),
		summary:
			record.analysis?.explanation ??
			context.t('viewModel.relationshipConflict', { relationship: record.relationship }),
		severity: contradictionSeverity(record),
		entity: `${record.source_entity_id} -> ${record.target_entity_id}`,
		createdAt: record.story_id ?? context.t('viewModel.noStoryLink'),
	}));
}

export function contradictionToClaim(
	record: ContradictionRecord,
	contextInput?: Partial<ViewModelContext>,
): EvidenceClaim {
	const context = getContext(contextInput);
	const status =
		record.edge_type === 'CONFIRMED_CONTRADICTION'
			? 'contradicted'
			: record.edge_type === 'DISMISSED_CONTRADICTION'
				? 'unverified'
				: 'watching';
	const confidence = record.analysis?.confidence ?? record.confidence ?? 0;
	const attributeSignal = record.attributes.attribute
		? context.t('viewModel.attribute', { attribute: record.attributes.attribute })
		: context.t('viewModel.attributePending');
	const verdictSignal = record.analysis
		? context.t('viewModel.verdict', { verdict: record.analysis.verdict })
		: context.t('viewModel.needsReview');

	return {
		id: record.id,
		claim:
			record.analysis?.explanation ??
			context.t('viewModel.contradictionCandidate', { relationship: record.relationship }),
		entity: `${record.source_entity_id} -> ${record.target_entity_id}`,
		status,
		confidence,
		lastSeen: record.story_id ?? context.t('viewModel.noStoryLink'),
		sourceCount: 2,
		citations: [],
		signals: [attributeSignal, verdictSignal, record.relationship],
	};
}

export function buildOverviewMetrics(
	{
		documents,
		evidence,
		status,
	}: {
		documents?: DocumentListResponse;
		evidence?: EvidenceSummaryResponse;
		status?: StatusResponse;
	},
	contextInput?: Partial<ViewModelContext>,
): Metric[] {
	const context = getContext(contextInput);
	const openContradictions = evidence
		? evidence.data.contradictions.potential + evidence.data.contradictions.confirmed
		: null;

	return [
		{
			label: context.t('viewModel.documentsIndexed'),
			value: formatNumber(documents?.meta.count, context.locale),
			delta: documents
				? context.t('viewModel.loaded', { count: formatNumber(documents.data.length, context.locale) })
				: context.t('common.apiPending'),
			tone: documents ? 'neutral' : 'warning',
		},
		{
			label: context.t('viewModel.entitiesResolved'),
			value: formatNumber(evidence?.data.entities.total, context.locale),
			delta: evidence
				? context.t('viewModel.scored', { count: formatNumber(evidence.data.entities.scored, context.locale) })
				: context.t('common.apiPending'),
			tone: evidence ? 'good' : 'warning',
		},
		{
			label: context.t('viewModel.openContradictions'),
			value: formatNumber(openContradictions, context.locale),
			delta: evidence
				? context.t('viewModel.confirmed', {
						count: formatNumber(evidence.data.contradictions.confirmed, context.locale),
					})
				: context.t('common.apiPending'),
			tone: openContradictions && openContradictions > 0 ? 'danger' : 'neutral',
		},
		{
			label: context.t('viewModel.queueRunning'),
			value: formatNumber(status?.data.jobs.running, context.locale),
			delta: status
				? context.t('viewModel.pending', { count: formatNumber(status.data.jobs.pending, context.locale) })
				: context.t('common.apiPending'),
			tone: status && status.data.jobs.failed + status.data.jobs.dead_letter > 0 ? 'warning' : 'neutral',
		},
	];
}
