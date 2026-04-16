import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
	type CostEstimate,
	detectNativeText,
	type EstimatedSourceProfile,
	type EstimatedStep,
	estimatePipelineCost,
	INGEST_ERROR_CODES,
	IngestError,
	type ReprocessableStep,
	type Source,
} from '@mulder/core';
import type { PipelineStepName } from '@mulder/pipeline';

interface ReprocessEstimateSourcePlan {
	sourceId: string;
	steps: readonly { stepName: ReprocessableStep }[];
}

const ESTIMATE_STEP_ORDER: readonly EstimatedStep[] = ['extract', 'segment', 'enrich', 'ground', 'embed', 'graph'];

export async function resolvePdfFiles(inputPath: string): Promise<string[]> {
	const resolved = resolve(inputPath);
	const stats = await stat(resolved).catch(() => null);

	if (!stats) {
		throw new IngestError(`Path not found: ${resolved}`, INGEST_ERROR_CODES.INGEST_FILE_NOT_FOUND, {
			context: { path: resolved },
		});
	}

	if (stats.isFile()) {
		return [resolved];
	}

	if (stats.isDirectory()) {
		const entries = await readdir(resolved, { recursive: true });
		const pdfFiles: string[] = [];
		for (const entry of entries) {
			if (entry.toLowerCase().endsWith('.pdf')) {
				pdfFiles.push(join(resolved, entry));
			}
		}
		return pdfFiles.sort();
	}

	throw new IngestError(
		`Path is neither a file nor a directory: ${resolved}`,
		INGEST_ERROR_CODES.INGEST_FILE_NOT_FOUND,
		{
			context: { path: resolved },
		},
	);
}

export async function collectPdfSourceProfiles(inputPath: string): Promise<EstimatedSourceProfile[]> {
	const pdfFiles = await resolvePdfFiles(inputPath);
	const sourceProfiles: EstimatedSourceProfile[] = [];

	for (const filePath of pdfFiles) {
		const buffer = await readFile(filePath);
		const nativeText = await detectNativeText(buffer);
		sourceProfiles.push({
			filename: filePath,
			pageCount: nativeText.pageCount,
			nativeTextRatio: nativeText.nativeTextRatio,
		});
	}

	return sourceProfiles;
}

export function collectDbSourceProfiles(sources: Source[]): EstimatedSourceProfile[] {
	return sources.map((source) => ({
		sourceId: source.id,
		filename: source.filename,
		pageCount: source.pageCount ?? 0,
		nativeTextRatio: source.nativeTextRatio,
	}));
}

function formatUsd(value: number): string {
	if (value > 0 && value < 0.01) {
		return `~$${value.toFixed(4)}`;
	}
	return `~$${value.toFixed(2)}`;
}

export function printCostEstimate(title: string, estimate: CostEstimate): void {
	process.stdout.write(`${title}\n`);
	process.stdout.write(`Sources: ${estimate.sourceCount}\n`);
	process.stdout.write(`Pages: ${estimate.totalPages}\n`);
	for (const step of estimate.steps) {
		process.stdout.write(`- ${step.step}: ${formatUsd(step.estimatedUsd)} (${step.basis})\n`);
	}
	process.stdout.write(`Total estimated: ${formatUsd(estimate.estimatedUsd)}\n`);
	for (const warning of estimate.warnings) {
		process.stdout.write(`Warning: ${warning}\n`);
	}
}

export function shouldShowEstimate(args: {
	explicit: boolean;
	estimate: CostEstimate;
	maxPagesWithoutConfirm: number;
	maxCostWithoutConfirmUsd: number;
}): boolean {
	return (
		args.explicit ||
		args.estimate.totalPages > args.maxPagesWithoutConfirm ||
		args.estimate.estimatedUsd > args.maxCostWithoutConfirmUsd
	);
}

export function requiresConfirmation(args: {
	explicit: boolean;
	dryRun: boolean;
	estimate: CostEstimate;
	maxPagesWithoutConfirm: number;
	maxCostWithoutConfirmUsd: number;
}): boolean {
	if (args.dryRun) {
		return false;
	}
	return shouldShowEstimate(args);
}

export function estimateForSteps(args: {
	mode: 'ingest' | 'pipeline' | 'reprocess';
	sourceProfiles: EstimatedSourceProfile[];
	steps: EstimatedStep[];
	groundingEnabled: boolean;
}): CostEstimate {
	return estimatePipelineCost({
		mode: args.mode,
		sourceProfiles: args.sourceProfiles,
		plannedSteps: args.steps,
		groundingEnabled: args.groundingEnabled,
	});
}

export function estimateForReprocessPlan(args: {
	sourceProfiles: EstimatedSourceProfile[];
	plannedSources: readonly ReprocessEstimateSourcePlan[];
	groundingEnabled: boolean;
}): CostEstimate {
	const profilesById = new Map<string, EstimatedSourceProfile>();
	for (const profile of args.sourceProfiles) {
		if (profile.sourceId) {
			profilesById.set(profile.sourceId, profile);
		}
	}

	const stepTotals = new Map<EstimatedStep, number>();
	const stepSourceCounts = new Map<EstimatedStep, number>();
	const warnings = new Set<string>();
	let sourceCount = 0;
	let totalPages = 0;
	let estimatedUsd = 0;

	for (const plannedSource of args.plannedSources) {
		const profile = profilesById.get(plannedSource.sourceId);
		if (!profile) {
			warnings.add(`Skipped a planned source without stored profile metadata: ${plannedSource.sourceId}`);
			continue;
		}

		sourceCount++;
		totalPages += profile.pageCount;
		const estimate = estimateForSteps({
			mode: 'reprocess',
			sourceProfiles: [profile],
			steps: mapReprocessStepsToEstimateSteps(plannedSource.steps.map((step) => step.stepName)),
			groundingEnabled: args.groundingEnabled,
		});

		estimatedUsd += estimate.estimatedUsd;
		for (const warning of estimate.warnings) {
			if (warning !== 'No eligible sources found for estimation.') {
				warnings.add(warning);
			}
		}
		for (const step of estimate.steps) {
			stepTotals.set(step.step, (stepTotals.get(step.step) ?? 0) + step.estimatedUsd);
			stepSourceCounts.set(step.step, (stepSourceCounts.get(step.step) ?? 0) + 1);
		}
	}

	if (sourceCount === 0) {
		warnings.add('No eligible sources found for estimation.');
	}

	return {
		sourceCount,
		totalPages,
		estimatedUsd: Math.round(estimatedUsd * 10000) / 10000,
		steps: ESTIMATE_STEP_ORDER.filter((step) => stepTotals.has(step)).map((step) => ({
			step,
			estimatedUsd: Math.round((stepTotals.get(step) ?? 0) * 10000) / 10000,
			basis: `planned across ${stepSourceCounts.get(step) ?? 0} source(s)`,
		})),
		warnings: [...warnings],
	};
}

export function mapPipelineStepsToEstimateSteps(plannedSteps: readonly PipelineStepName[]): EstimatedStep[] {
	const estimatedSteps: EstimatedStep[] = [];

	for (const step of plannedSteps) {
		switch (step) {
			case 'extract':
			case 'segment':
			case 'enrich':
			case 'embed':
			case 'graph':
				estimatedSteps.push(step);
				break;
			case 'ingest':
				break;
		}
	}

	return estimatedSteps;
}

export function mapReprocessStepsToEstimateSteps(steps: readonly ReprocessableStep[]): EstimatedStep[] {
	return steps.map((step) => step);
}

export async function promptYesNo(question: string): Promise<boolean> {
	return new Promise((resolvePrompt) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		let resolved = false;

		const resolveOnce = (value: boolean) => {
			if (resolved) {
				return;
			}
			resolved = true;
			rl.close();
			resolvePrompt(value);
		};

		rl.on('close', () => {
			if (!resolved) {
				resolved = true;
				resolvePrompt(false);
			}
		});

		rl.question(`${question} `, (answer) => {
			const normalized = answer.trim().toLowerCase();
			resolveOnce(normalized === 'y' || normalized === 'yes');
		});
	});
}
