import type { JobProgress, JobSummary } from '@/lib/api-types';
import type { AnalysisRun, RunStatus } from '@/lib/types';
import { jobToAnalysisRun } from '@/lib/view-models';

export const DOCUMENT_PROCESSING_STEPS = [
	'upload',
	'quality',
	'extract',
	'segment',
	'enrich',
	'embed',
	'graph',
	'analyze',
] as const;

export type DocumentProcessingStepName = (typeof DOCUMENT_PROCESSING_STEPS)[number];
export type DocumentProcessingCurrentStep =
	| DocumentProcessingStepName
	| 'analyze_pending'
	| 'completed'
	| 'processing'
	| 'translation'
	| 'unknown';
export type DocumentProcessingStepStatus =
	| 'not_started'
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'skipped'
	| 'partial';

export interface DocumentProcessingJob {
	job: JobSummary;
	run: AnalysisRun;
}

export interface DocumentProcessingStep {
	name: DocumentProcessingStepName;
	status: DocumentProcessingStepStatus;
	activityAt: string | null;
	errorMessage: string | null;
	attempts: string | null;
}

export interface DocumentTranslationStep {
	id: string;
	status: RunStatus;
	label: string;
	activityAt: string | null;
	errorMessage: string | null;
	attempts: string;
}

export interface DocumentProcessingGroup {
	id: string;
	sourceId?: string;
	title: string;
	jobs: DocumentProcessingJob[];
	uploadJob?: DocumentProcessingJob;
	pipelineJob?: DocumentProcessingJob;
	translationJobs: DocumentProcessingJob[];
	otherJobs: DocumentProcessingJob[];
	latestJob: DocumentProcessingJob;
	status: RunStatus;
	currentStep: DocumentProcessingCurrentStep;
	lastActivity: string | null;
	attempts: string;
}

type ObservabilityStep = {
	step: string;
	status: 'pending' | 'completed' | 'failed' | 'partial' | 'skipped';
	completed_at: string | null;
	error_message: string | null;
};

type ProgressSource = JobProgress['sources'][number] | null | undefined;

const singleStepJobTypes = new Set(['quality', 'extract', 'segment', 'enrich', 'embed', 'graph', 'analyze']);
const mainPipelineJobTypes = new Set(['document_upload_finalize', 'pipeline_run', ...singleStepJobTypes]);

function mapRunStatus(status: JobSummary['status']): RunStatus {
	if (status === 'pending') return 'queued';
	if (status === 'dead_letter') return 'failed';
	return status;
}

function mapJobStatusToStepStatus(status: JobSummary['status']): DocumentProcessingStepStatus {
	if (status === 'pending') return 'queued';
	if (status === 'running') return 'running';
	if (status === 'completed') return 'completed';
	return 'failed';
}

export function mapJobTypeToCurrentStep(type: string): DocumentProcessingCurrentStep {
	if (type === 'document_upload_finalize') return 'upload';
	if (type === 'translate') return 'translation';
	if (singleStepJobTypes.has(type)) return type as DocumentProcessingStepName;
	if (type === 'pipeline_run') return 'processing';
	return 'unknown';
}

function isMainPipelineJob(job: JobSummary): boolean {
	return mainPipelineJobTypes.has(job.type);
}

function isPipelineExecutionJob(job: JobSummary): boolean {
	return job.type === 'pipeline_run' || singleStepJobTypes.has(job.type);
}

function relevantAttempts(job: JobSummary): string | null {
	const attempts = job.attempts ?? 0;
	const maxAttempts = job.max_attempts ?? 0;
	if (attempts <= 1 && job.status === 'completed') return null;
	if (attempts <= 1 && job.status === 'pending') return null;
	if (attempts <= 0 || maxAttempts <= 0) return null;
	return `${attempts}/${maxAttempts}`;
}

export function jobActivityTimestamp(job: JobSummary): string {
	return job.finished_at ?? job.started_at ?? job.created_at;
}

function activityTime(job: JobSummary): number {
	return new Date(jobActivityTimestamp(job)).getTime();
}

function compareActivityDesc(left: DocumentProcessingJob, right: DocumentProcessingJob): number {
	return activityTime(right.job) - activityTime(left.job);
}

export function aggregateDocumentStatus(jobs: DocumentProcessingJob[]): RunStatus {
	const mainJobs = jobs.filter(({ job }) => isMainPipelineJob(job));
	const statuses = mainJobs.map(({ job }) => mapRunStatus(job.status));
	if (statuses.includes('running')) return 'running';
	if (statuses.includes('queued')) return 'queued';
	const latestMain = [...mainJobs].sort(compareActivityDesc)[0];
	if (latestMain) return mapRunStatus(latestMain.job.status);
	return statuses[0] ?? 'queued';
}

function chooseCurrentJob(jobs: DocumentProcessingJob[]): DocumentProcessingJob {
	const mainJobs = jobs.filter(({ job }) => isMainPipelineJob(job));
	const candidates = mainJobs.length > 0 ? mainJobs : jobs;
	return (
		candidates.find(({ run }) => run.status === 'running') ??
		candidates.find(({ run }) => run.status === 'queued') ??
		[...candidates].sort(compareActivityDesc)[0] ??
		jobs[0]
	);
}

function normalizedLabel(label: string): string {
	return label.trim().toLowerCase();
}

function labelSourceIndex(jobs: JobSummary[]): Map<string, string> {
	const candidates = new Map<string, Set<string>>();
	for (const job of jobs) {
		if (!job.subject.source_id) continue;
		const label = normalizedLabel(job.subject.label);
		const sourceIds = candidates.get(label) ?? new Set<string>();
		sourceIds.add(job.subject.source_id);
		candidates.set(label, sourceIds);
	}
	return new Map(
		Array.from(candidates.entries())
			.filter(([, sourceIds]) => sourceIds.size === 1)
			.map(([label, sourceIds]) => [label, Array.from(sourceIds)[0]]),
	);
}

function documentGroupKey(job: JobSummary, sourceByLabel: Map<string, string>): string {
	if (job.subject.source_id) return `source:${job.subject.source_id}`;
	const matchedSourceId = sourceByLabel.get(normalizedLabel(job.subject.label));
	return matchedSourceId ? `source:${matchedSourceId}` : `label:${normalizedLabel(job.subject.label)}`;
}

function defaultDocumentTitle(jobs: DocumentProcessingJob[]): string {
	const sourceJob = jobs.find(({ job }) => job.subject.kind === 'source');
	return sourceJob?.job.subject.label ?? jobs[0].job.subject.label;
}

function sourceIdForGroup(jobs: DocumentProcessingJob[]): string | undefined {
	return jobs.find(({ job }) => job.subject.source_id)?.job.subject.source_id;
}

function latestPipelineJob(jobs: DocumentProcessingJob[]): DocumentProcessingJob | undefined {
	return jobs.filter(({ job }) => isPipelineExecutionJob(job)).sort(compareActivityDesc)[0];
}

export function createDocumentProcessingGroups(
	jobs: JobSummary[],
	context?: Parameters<typeof jobToAnalysisRun>[1],
): DocumentProcessingGroup[] {
	const grouped = new Map<string, DocumentProcessingJob[]>();
	const sourceByLabel = labelSourceIndex(jobs);
	for (const job of jobs) {
		const row = { job, run: jobToAnalysisRun(job, context) };
		const key = documentGroupKey(job, sourceByLabel);
		grouped.set(key, [...(grouped.get(key) ?? []), row]);
	}

	return Array.from(grouped.entries())
		.map(([id, rows]) => {
			const orderedJobs = [...rows].sort(compareActivityDesc);
			const latestJob = orderedJobs[0];
			const currentJob = chooseCurrentJob(orderedJobs);
			const translationJobs = orderedJobs.filter(({ job }) => job.type === 'translate');
			const uploadJob = orderedJobs.find(({ job }) => job.type === 'document_upload_finalize');
			const pipelineJob = latestPipelineJob(orderedJobs);
			const knownJobIds = new Set([
				uploadJob?.job.id,
				pipelineJob?.job.id,
				...translationJobs.map(({ job }) => job.id),
			]);
			const otherJobs = orderedJobs.filter(({ job }) => !knownJobIds.has(job.id));
			return {
				id,
				sourceId: sourceIdForGroup(orderedJobs),
				title: defaultDocumentTitle(orderedJobs),
				jobs: orderedJobs,
				uploadJob,
				pipelineJob,
				translationJobs,
				otherJobs,
				latestJob,
				status: aggregateDocumentStatus(orderedJobs),
				currentStep: mapJobTypeToCurrentStep(currentJob.job.type),
				lastActivity: jobActivityTimestamp(latestJob.job),
				attempts: relevantAttempts(latestJob.job) ?? '',
			};
		})
		.sort((a, b) => {
			if (!a.lastActivity || !b.lastActivity) return 0;
			return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
		});
}

export function findDocumentGroupForJob(
	groups: DocumentProcessingGroup[],
	jobId: string | null | undefined,
): DocumentProcessingGroup | undefined {
	if (!jobId) return undefined;
	return groups.find((group) => group.jobs.some(({ job }) => job.id === jobId));
}

export function preferredJobIdForGroup(group: DocumentProcessingGroup | undefined): string | undefined {
	return group?.pipelineJob?.job.id ?? group?.latestJob.job.id;
}

export function progressSourceForGroup(
	progress: JobProgress | null | undefined,
	group: DocumentProcessingGroup | undefined,
): ProgressSource {
	if (!progress || !group) return null;
	if (group.sourceId) {
		return progress.sources.find((source) => source.source_id === group.sourceId) ?? null;
	}
	return progress.sources[0] ?? null;
}

function mapStepStatus(status: ObservabilityStep['status'] | undefined): DocumentProcessingStepStatus {
	if (!status || status === 'pending') return 'not_started';
	return status;
}

function mapProgressStatus(status: NonNullable<ProgressSource>['status']): DocumentProcessingStepStatus {
	if (status === 'processing') return 'running';
	if (status === 'pending') return 'not_started';
	return status;
}

export function buildDocumentProcessingSteps(
	group: DocumentProcessingGroup,
	input: {
		observabilitySteps?: ObservabilityStep[];
		progressSource?: ProgressSource;
	},
): DocumentProcessingStep[] {
	const storedByName = new Map((input.observabilitySteps ?? []).map((step) => [step.step, step]));
	const progressSource = input.progressSource;
	return DOCUMENT_PROCESSING_STEPS.map((name) => {
		if (name === 'upload') {
			return {
				name,
				status: group.uploadJob ? mapJobStatusToStepStatus(group.uploadJob.job.status) : 'not_started',
				activityAt: group.uploadJob ? jobActivityTimestamp(group.uploadJob.job) : null,
				errorMessage: group.uploadJob?.run.error ?? null,
				attempts: group.uploadJob ? relevantAttempts(group.uploadJob.job) : null,
			};
		}

		const stored = storedByName.get(name);
		const explicitJob = group.jobs.find(({ job }) => job.type === name);
		const isCurrentProgress = progressSource?.current_step === name;
		const status = isCurrentProgress
			? mapProgressStatus(progressSource.status)
			: stored
				? mapStepStatus(stored.status)
				: explicitJob
					? mapJobStatusToStepStatus(explicitJob.job.status)
					: 'not_started';

		const errorMessage =
			isCurrentProgress && progressSource.status === 'failed'
				? progressSource.error_message
				: (stored?.error_message ?? explicitJob?.run.error ?? null);
		return {
			name,
			status,
			activityAt: isCurrentProgress
				? progressSource.updated_at
				: (stored?.completed_at ?? (explicitJob ? jobActivityTimestamp(explicitJob.job) : null)),
			errorMessage: status === 'failed' ? errorMessage : null,
			attempts:
				status === 'failed' || status === 'running'
					? ((explicitJob ? relevantAttempts(explicitJob.job) : null) ??
						(group.pipelineJob ? relevantAttempts(group.pipelineJob.job) : null))
					: null,
		};
	});
}

export function buildDocumentTranslationSteps(group: DocumentProcessingGroup): DocumentTranslationStep[] {
	return group.translationJobs.map(({ job, run }) => ({
		id: job.id,
		status: run.status,
		label: job.type,
		activityAt: jobActivityTimestamp(job),
		errorMessage: run.status === 'failed' ? (run.error ?? null) : null,
		attempts: relevantAttempts(job) ?? '',
	}));
}

export function currentStepForDocument(
	group: DocumentProcessingGroup,
	input: {
		observabilitySteps?: ObservabilityStep[];
		progressSource?: ProgressSource;
	} = {},
): DocumentProcessingCurrentStep {
	const progressSource = input.progressSource;
	if (progressSource?.status === 'processing' || progressSource?.status === 'failed') {
		return DOCUMENT_PROCESSING_STEPS.includes(progressSource.current_step as DocumentProcessingStepName)
			? (progressSource.current_step as DocumentProcessingStepName)
			: group.currentStep;
	}

	const steps = buildDocumentProcessingSteps(group, input);
	const running = steps.find((step) => step.status === 'running');
	if (running) return running.name;
	const failed = steps.find((step) => step.status === 'failed');
	if (failed) return failed.name;
	const queued = steps.find((step) => step.status === 'queued');
	if (queued) return queued.name;

	const graph = steps.find((step) => step.name === 'graph');
	const analyze = steps.find((step) => step.name === 'analyze');
	if (graph?.status === 'completed' && analyze?.status === 'not_started') return 'analyze_pending';
	if (
		steps.every((step) => step.status === 'completed' || step.status === 'skipped') &&
		steps.some((step) => step.status === 'completed')
	) {
		return 'completed';
	}

	const active = steps.find((step) => step.status !== 'not_started' && step.status !== 'skipped');
	return active?.name ?? group.currentStep;
}
