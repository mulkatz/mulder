/**
 * Transparent, heuristic cost estimates for Mulder CLI workflows.
 *
 * The output is intentionally approximate: enough to gate expensive work
 * and communicate risk without pretending to mirror Cloud Billing exactly.
 */

export type EstimatedStep = 'extract' | 'segment' | 'enrich' | 'ground' | 'embed' | 'graph';

export interface EstimatedSourceProfile {
	sourceId?: string;
	filename: string;
	pageCount: number;
	nativeTextRatio: number | null;
	storyCount?: number | null;
}

export interface CostEstimateInput {
	mode: 'ingest' | 'pipeline' | 'reprocess';
	sourceProfiles: EstimatedSourceProfile[];
	plannedSteps: EstimatedStep[];
	groundingEnabled: boolean;
}

export interface CostEstimateStepLine {
	step: EstimatedStep;
	estimatedUsd: number;
	basis: string;
}

export interface CostEstimate {
	sourceCount: number;
	totalPages: number;
	estimatedUsd: number;
	steps: CostEstimateStepLine[];
	warnings: string[];
}

const PRICE_PER_SCANNED_PAGE_USD = 0.0015;
const PRICE_PER_SEGMENT_PAGE_USD = 0.00055;
const PRICE_PER_ENRICH_PAGE_USD = 0.00021;
const PRICE_PER_GROUND_PAGE_USD = 0.00014;
const PRICE_PER_EMBED_PAGE_USD = 0.0001;
const PRICE_PER_GRAPH_PAGE_USD = 0;

function roundUsd(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function sumPages(sourceProfiles: EstimatedSourceProfile[]): number {
	let total = 0;
	for (const source of sourceProfiles) {
		total += source.pageCount;
	}
	return total;
}

function sumScannedPages(sourceProfiles: EstimatedSourceProfile[]): number {
	let total = 0;
	for (const source of sourceProfiles) {
		const nativeRatio = source.nativeTextRatio ?? 0;
		const scannedPages = source.pageCount * Math.max(0, 1 - nativeRatio);
		total += scannedPages;
	}
	return total;
}

function buildStepLine(step: EstimatedStep, estimatedUsd: number, basis: string): CostEstimateStepLine {
	return {
		step,
		estimatedUsd: roundUsd(estimatedUsd),
		basis,
	};
}

export function estimatePipelineCost(input: CostEstimateInput): CostEstimate {
	const totalPages = sumPages(input.sourceProfiles);
	const scannedPages = sumScannedPages(input.sourceProfiles);
	const warnings: string[] = [];
	const steps: CostEstimateStepLine[] = [];

	if (input.sourceProfiles.length === 0) {
		warnings.push('No eligible sources found for estimation.');
	}

	for (const step of input.plannedSteps) {
		switch (step) {
			case 'extract': {
				steps.push(
					buildStepLine(
						step,
						scannedPages * PRICE_PER_SCANNED_PAGE_USD,
						`${Math.round(scannedPages)} scanned-page equivalent(s)`,
					),
				);
				break;
			}
			case 'segment': {
				steps.push(buildStepLine(step, totalPages * PRICE_PER_SEGMENT_PAGE_USD, `${totalPages} page(s)`));
				break;
			}
			case 'enrich': {
				steps.push(buildStepLine(step, totalPages * PRICE_PER_ENRICH_PAGE_USD, `${totalPages} page(s)`));
				break;
			}
			case 'ground': {
				const estimatedUsd = input.groundingEnabled ? totalPages * PRICE_PER_GROUND_PAGE_USD : 0;
				const basis = input.groundingEnabled ? `${totalPages} page(s)` : 'grounding disabled';
				steps.push(buildStepLine(step, estimatedUsd, basis));
				break;
			}
			case 'embed': {
				steps.push(buildStepLine(step, totalPages * PRICE_PER_EMBED_PAGE_USD, `${totalPages} page(s)`));
				break;
			}
			case 'graph': {
				steps.push(buildStepLine(step, totalPages * PRICE_PER_GRAPH_PAGE_USD, `${totalPages} page(s)`));
				break;
			}
		}
	}

	const estimatedUsd = steps.reduce((sum, step) => sum + step.estimatedUsd, 0);

	warnings.push('Estimate uses fixed heuristics and may differ from actual provider billing.');

	return {
		sourceCount: input.sourceProfiles.length,
		totalPages,
		estimatedUsd: roundUsd(estimatedUsd),
		steps,
		warnings,
	};
}
