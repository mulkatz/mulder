/**
 * Shared helpers for the `mulder eval` CLI command.
 *
 * The CLI stays thin: this module resolves repo-local paths, runs the public
 * `@mulder/eval` suites, compares against the checked-in baseline, and formats
 * the command output shape.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
	type AssertionClassificationEvalResult,
	type EntityEvalResult,
	EVAL_ERROR_CODES,
	type ExtractionEvalResult,
	MulderEvalError,
	type QualityRoutingEvalResult,
	runAssertionClassificationEval,
	runEntityEval,
	runExtractionEval,
	runQualityRoutingEval,
	runSegmentationEval,
	type SegmentationEvalResult,
} from '@mulder/eval';

export const VALID_EVAL_STEPS = ['extract', 'segment', 'enrich', 'quality', 'assertions'] as const;

const STEP_TO_SUITE = {
	extract: 'extraction',
	segment: 'segmentation',
	enrich: 'entities',
	quality: 'qualityRouting',
	assertions: 'assertions',
} as const;

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const GOLDEN_ROOT = resolve(REPO_ROOT, 'eval/golden');
const BASELINE_PATH = resolve(REPO_ROOT, 'eval/metrics/baseline.json');

type EvalStep = (typeof VALID_EVAL_STEPS)[number];
type EvalSuite = (typeof STEP_TO_SUITE)[EvalStep];
type EvalSelectionStep = 'all' | EvalStep;

type EvalResults = Partial<{
	extraction: ExtractionEvalResult;
	segmentation: SegmentationEvalResult;
	entities: EntityEvalResult;
	qualityRouting: QualityRoutingEvalResult;
	assertions: AssertionClassificationEvalResult;
}>;

interface EntityTypeComparisonMetrics {
	avgPrecision: EvalMetricComparison;
	avgRecall: EvalMetricComparison;
	avgF1: EvalMetricComparison;
}

type ExtractionComparison = {
	summary: {
		avgCer: EvalMetricComparison;
		avgWer: EvalMetricComparison;
		maxCer: EvalMetricComparison;
		maxWer: EvalMetricComparison;
	};
};

type SegmentationComparison = {
	summary: {
		avgBoundaryAccuracy: EvalMetricComparison;
		segmentCountExactRatio: EvalMetricComparison;
	};
};

type EntityComparison = {
	summary: {
		overall: {
			avgPrecision: EvalMetricComparison;
			avgRecall: EvalMetricComparison;
			avgF1: EvalMetricComparison;
		};
		byType: Record<
			string,
			{
				avgPrecision: EvalMetricComparison;
				avgRecall: EvalMetricComparison;
				avgF1: EvalMetricComparison;
			}
		>;
	};
};

type FixtureSuiteComparison = {
	summary: {
		passRate: EvalMetricComparison;
		failedCases: EvalMetricComparison;
	};
};

export interface EvalCommandOptions {
	step?: string;
	compare?: string;
	updateBaseline?: boolean;
	json?: boolean;
}

export interface EvalMetricComparison {
	current: number;
	baseline: number;
	delta: number;
	status: 'improved' | 'regressed' | 'unchanged';
}

export interface EvalComparisonResult {
	against: 'baseline';
	suites: Partial<{
		extraction: ExtractionComparison;
		segmentation: SegmentationComparison;
		entities: EntityComparison;
		qualityRouting: FixtureSuiteComparison;
		assertions: FixtureSuiteComparison;
	}>;
}

export interface EvalCommandResult {
	step: EvalSelectionStep;
	results: EvalResults;
	comparison?: EvalComparisonResult;
	baselineUpdated: boolean;
}

interface EvalRunSelection {
	step: EvalSelectionStep;
	suites: EvalSuite[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertValidStep(step: string | undefined): asserts step is EvalStep | undefined {
	if (step === undefined) {
		return;
	}

	if (!VALID_EVAL_STEPS.some((validStep) => validStep === step)) {
		throw new MulderEvalError(
			`Invalid --step "${step}". Valid steps: ${VALID_EVAL_STEPS.join(', ')}`,
			EVAL_ERROR_CODES.INVALID_ARGUMENT,
		);
	}
}

function normalizeStep(step?: string): EvalRunSelection {
	assertValidStep(step);

	if (step === undefined) {
		return { step: 'all', suites: ['extraction', 'segmentation', 'entities', 'qualityRouting', 'assertions'] };
	}

	return {
		step,
		suites: [STEP_TO_SUITE[step]],
	};
}

function assertValidCompare(compare: string | undefined): void {
	if (compare === undefined) {
		return;
	}

	if (compare !== 'baseline') {
		throw new MulderEvalError(
			`Invalid --compare "${compare}". Valid values: baseline`,
			EVAL_ERROR_CODES.INVALID_ARGUMENT,
		);
	}
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function formatDelta(value: number): string {
	const sign = value > 0 ? '+' : '';
	return `${sign}${(value * 100).toFixed(2)} pp`;
}

function formatStatus(current: number, baseline: number, higherIsBetter: boolean): EvalMetricComparison['status'] {
	const delta = current - baseline;
	if (Math.abs(delta) < 1e-12) {
		return 'unchanged';
	}

	if (higherIsBetter) {
		return delta > 0 ? 'improved' : 'regressed';
	}

	return delta < 0 ? 'improved' : 'regressed';
}

function compareMetric(current: number, baseline: number, higherIsBetter: boolean): EvalMetricComparison {
	return {
		current,
		baseline,
		delta: current - baseline,
		status: formatStatus(current, baseline, higherIsBetter),
	};
}

function readNumericPath(value: unknown, path: string[]): number {
	let cursor: unknown = value;
	for (const key of path) {
		if (!isPlainObject(cursor) || !(key in cursor)) {
			throw new MulderEvalError(
				`Baseline is missing required metric path: ${path.join('.')}`,
				EVAL_ERROR_CODES.INVALID_ARGUMENT,
				{ context: { path: path.join('.') } },
			);
		}
		cursor = cursor[key];
	}

	if (typeof cursor !== 'number' || Number.isNaN(cursor)) {
		throw new MulderEvalError(
			`Baseline metric path is not numeric: ${path.join('.')}`,
			EVAL_ERROR_CODES.INVALID_ARGUMENT,
			{ context: { path: path.join('.') } },
		);
	}

	return cursor;
}

function loadBaselineRoot(requireExisting: boolean): Record<string, unknown> {
	if (!existsSync(BASELINE_PATH)) {
		if (requireExisting) {
			throw new MulderEvalError(`Baseline file not found: ${BASELINE_PATH}`, EVAL_ERROR_CODES.FIXTURE_NOT_FOUND, {
				context: { baselinePath: BASELINE_PATH },
			});
		}

		return {};
	}

	const raw = readFileSync(BASELINE_PATH, 'utf-8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new MulderEvalError(`Failed to parse baseline JSON: ${BASELINE_PATH}`, EVAL_ERROR_CODES.INVALID_ARGUMENT, {
			context: { baselinePath: BASELINE_PATH },
			cause,
		});
	}

	if (!isPlainObject(parsed)) {
		throw new MulderEvalError(`Baseline JSON must be an object: ${BASELINE_PATH}`, EVAL_ERROR_CODES.INVALID_ARGUMENT, {
			context: { baselinePath: BASELINE_PATH },
		});
	}

	return parsed;
}

function writeBaselineRoot(nextBaseline: Record<string, unknown>): void {
	const dir = dirname(BASELINE_PATH);
	mkdirSync(dir, { recursive: true });

	const tempPath = resolve(dir, `.baseline.json.tmp-${process.pid}-${Date.now()}`);
	try {
		writeFileSync(tempPath, `${JSON.stringify(nextBaseline, null, 2)}\n`);
		renameSync(tempPath, BASELINE_PATH);
	} catch (cause) {
		try {
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
		} catch {
			// Ignore cleanup failures; the original baseline is still intact.
		}

		throw new MulderEvalError(`Failed to update baseline JSON: ${BASELINE_PATH}`, EVAL_ERROR_CODES.INVALID_ARGUMENT, {
			context: { baselinePath: BASELINE_PATH },
			cause,
		});
	}
}

function buildComparison(
	results: EvalResults,
	baselineRoot: Record<string, unknown>,
	suites: EvalSuite[],
): EvalComparisonResult {
	const comparison: EvalComparisonResult = {
		against: 'baseline',
		suites: {},
	};

	for (const suite of suites) {
		const suiteKey = suite;
		const baselineSuite = baselineRoot[suiteKey];
		if (!isPlainObject(baselineSuite)) {
			throw new MulderEvalError(
				`Baseline is missing required suite section: ${suiteKey}`,
				EVAL_ERROR_CODES.INVALID_ARGUMENT,
				{ context: { suite: suiteKey } },
			);
		}

		switch (suiteKey) {
			case 'extraction': {
				const current = results.extraction;
				if (!current) {
					continue;
				}

				comparison.suites.extraction = {
					summary: {
						avgCer: compareMetric(current.summary.avgCer, readNumericPath(baselineSuite, ['summary', 'avgCer']), false),
						avgWer: compareMetric(current.summary.avgWer, readNumericPath(baselineSuite, ['summary', 'avgWer']), false),
						maxCer: compareMetric(current.summary.maxCer, readNumericPath(baselineSuite, ['summary', 'maxCer']), false),
						maxWer: compareMetric(current.summary.maxWer, readNumericPath(baselineSuite, ['summary', 'maxWer']), false),
					},
				};
				break;
			}
			case 'segmentation': {
				const current = results.segmentation;
				if (!current) {
					continue;
				}

				comparison.suites.segmentation = {
					summary: {
						avgBoundaryAccuracy: compareMetric(
							current.summary.avgBoundaryAccuracy,
							readNumericPath(baselineSuite, ['summary', 'avgBoundaryAccuracy']),
							true,
						),
						segmentCountExactRatio: compareMetric(
							current.summary.segmentCountExactRatio,
							readNumericPath(baselineSuite, ['summary', 'segmentCountExactRatio']),
							true,
						),
					},
				};
				break;
			}
			case 'entities': {
				const current = results.entities;
				if (!current) {
					continue;
				}

				const byType: Record<string, EntityTypeComparisonMetrics> = {};
				const baselineSummary = isPlainObject(baselineSuite.summary) ? baselineSuite.summary : null;
				if (!baselineSummary) {
					throw new MulderEvalError(
						'Baseline is missing required suite section: entities.summary',
						EVAL_ERROR_CODES.INVALID_ARGUMENT,
						{ context: { suite: suiteKey } },
					);
				}

				const currentByType = current.summary.byType;
				const baselineByType = isPlainObject(baselineSummary.byType) ? baselineSummary.byType : null;

				for (const [type, metrics] of Object.entries(currentByType)) {
					const baselineType = baselineByType ? baselineByType[type] : undefined;
					if (!isPlainObject(baselineType)) {
						throw new MulderEvalError(
							`Baseline is missing required entity type section: ${type}`,
							EVAL_ERROR_CODES.INVALID_ARGUMENT,
							{ context: { type } },
						);
					}

					byType[type] = {
						avgPrecision: compareMetric(metrics.avgPrecision, readNumericPath(baselineType, ['avgPrecision']), true),
						avgRecall: compareMetric(metrics.avgRecall, readNumericPath(baselineType, ['avgRecall']), true),
						avgF1: compareMetric(metrics.avgF1, readNumericPath(baselineType, ['avgF1']), true),
					};
				}

				comparison.suites.entities = {
					summary: {
						overall: {
							avgPrecision: compareMetric(
								current.summary.overall.avgPrecision,
								readNumericPath(baselineSuite, ['summary', 'overall', 'avgPrecision']),
								true,
							),
							avgRecall: compareMetric(
								current.summary.overall.avgRecall,
								readNumericPath(baselineSuite, ['summary', 'overall', 'avgRecall']),
								true,
							),
							avgF1: compareMetric(
								current.summary.overall.avgF1,
								readNumericPath(baselineSuite, ['summary', 'overall', 'avgF1']),
								true,
							),
						},
						byType,
					},
				};
				break;
			}
			case 'qualityRouting': {
				const current = results.qualityRouting;
				if (!current) {
					continue;
				}

				comparison.suites.qualityRouting = {
					summary: {
						passRate: compareMetric(
							current.summary.passRate,
							readNumericPath(baselineSuite, ['summary', 'passRate']),
							true,
						),
						failedCases: compareMetric(
							current.summary.failedCases,
							readNumericPath(baselineSuite, ['summary', 'failedCases']),
							false,
						),
					},
				};
				break;
			}
			case 'assertions': {
				const current = results.assertions;
				if (!current) {
					continue;
				}

				comparison.suites.assertions = {
					summary: {
						passRate: compareMetric(
							current.summary.passRate,
							readNumericPath(baselineSuite, ['summary', 'passRate']),
							true,
						),
						failedCases: compareMetric(
							current.summary.failedCases,
							readNumericPath(baselineSuite, ['summary', 'failedCases']),
							false,
						),
					},
				};
				break;
			}
		}
	}

	return comparison;
}

function renderComparisonLine(label: string, metric: EvalMetricComparison): string {
	return `  ${label.padEnd(24)} ${formatPercent(metric.current)} (baseline ${formatPercent(metric.baseline)}, delta ${formatDelta(metric.delta)}) ${metric.status}`;
}

function renderNumberComparisonLine(label: string, metric: EvalMetricComparison): string {
	const sign = metric.delta > 0 ? '+' : '';
	return `  ${label.padEnd(24)} ${metric.current} (baseline ${metric.baseline}, delta ${sign}${metric.delta}) ${metric.status}`;
}

function renderEntityCurrentRows(
	byType: Record<string, { avgPrecision: number; avgRecall: number; avgF1: number }>,
): string[] {
	const rows: string[] = [];
	const types = Object.keys(byType).sort((left, right) => left.localeCompare(right));

	for (const type of types) {
		const metrics = byType[type];
		rows.push(
			`  ${type.padEnd(18)} precision ${formatPercent(metrics.avgPrecision)}  recall ${formatPercent(metrics.avgRecall)}  F1 ${formatPercent(metrics.avgF1)}`,
		);
	}

	return rows;
}

function renderEntityComparisonRows(
	byType: Record<
		string,
		{ avgPrecision: EvalMetricComparison; avgRecall: EvalMetricComparison; avgF1: EvalMetricComparison }
	>,
): string[] {
	const rows: string[] = [];
	const types = Object.keys(byType).sort((left, right) => left.localeCompare(right));

	for (const type of types) {
		const metrics = byType[type];
		rows.push(
			`  ${type.padEnd(18)} precision ${formatPercent(metrics.avgPrecision.current)} (baseline ${formatPercent(metrics.avgPrecision.baseline)}, delta ${formatDelta(metrics.avgPrecision.delta)}) ${metrics.avgPrecision.status}`,
		);
		rows.push(
			`  ${' '.repeat(18)} recall    ${formatPercent(metrics.avgRecall.current)} (baseline ${formatPercent(metrics.avgRecall.baseline)}, delta ${formatDelta(metrics.avgRecall.delta)}) ${metrics.avgRecall.status}`,
		);
		rows.push(
			`  ${' '.repeat(18)} F1        ${formatPercent(metrics.avgF1.current)} (baseline ${formatPercent(metrics.avgF1.baseline)}, delta ${formatDelta(metrics.avgF1.delta)}) ${metrics.avgF1.status}`,
		);
	}

	return rows;
}

function renderExtractionReport(result: ExtractionEvalResult, comparison?: ExtractionComparison): string[] {
	const lines: string[] = [
		'Extraction Quality',
		`  Pages: ${result.summary.totalPages}`,
		`  CER: ${formatPercent(result.summary.avgCer)}  WER: ${formatPercent(result.summary.avgWer)}`,
		`  Max CER: ${formatPercent(result.summary.maxCer)}  Max WER: ${formatPercent(result.summary.maxWer)}`,
	];

	if (comparison?.summary) {
		lines.push(renderComparisonLine('CER', comparison.summary.avgCer));
		lines.push(renderComparisonLine('WER', comparison.summary.avgWer));
		lines.push(renderComparisonLine('Max CER', comparison.summary.maxCer));
		lines.push(renderComparisonLine('Max WER', comparison.summary.maxWer));
	}

	return lines;
}

function renderSegmentationReport(result: SegmentationEvalResult, comparison?: SegmentationComparison): string[] {
	const lines: string[] = [
		'Segmentation Quality',
		`  Documents: ${result.summary.totalDocuments}`,
		`  Boundary Accuracy: ${formatPercent(result.summary.avgBoundaryAccuracy)}`,
		`  Segment Count Exact Ratio: ${formatPercent(result.summary.segmentCountExactRatio)}`,
	];

	if (comparison?.summary) {
		lines.push(renderComparisonLine('Boundary Accuracy', comparison.summary.avgBoundaryAccuracy));
		lines.push(renderComparisonLine('Segment Count Exact Ratio', comparison.summary.segmentCountExactRatio));
	}

	return lines;
}

function renderEntityReport(result: EntityEvalResult, comparison?: EntityComparison): string[] {
	const lines: string[] = [
		'Entity Extraction',
		`  Segments: ${result.summary.totalSegments}`,
		`  Overall: precision ${formatPercent(result.summary.overall.avgPrecision)}  recall ${formatPercent(result.summary.overall.avgRecall)}  F1 ${formatPercent(result.summary.overall.avgF1)}`,
	];

	if (comparison?.summary) {
		lines.push(renderComparisonLine('Overall precision', comparison.summary.overall.avgPrecision));
		lines.push(renderComparisonLine('Overall recall', comparison.summary.overall.avgRecall));
		lines.push(renderComparisonLine('Overall F1', comparison.summary.overall.avgF1));
		lines.push('  Per-type comparison:');
		for (const row of renderEntityComparisonRows(comparison.summary.byType)) {
			lines.push(row);
		}
	} else {
		lines.push('  Per-type metrics:');
		for (const row of renderEntityCurrentRows(result.summary.byType)) {
			lines.push(row);
		}
	}

	return lines;
}

function renderFixtureSuiteReport(
	title: string,
	result: QualityRoutingEvalResult | AssertionClassificationEvalResult,
	comparison?: FixtureSuiteComparison,
): string[] {
	const lines: string[] = [
		title,
		`  Cases: ${result.summary.totalCases}`,
		`  Passed: ${result.summary.passedCases}  Failed: ${result.summary.failedCases}`,
		`  Pass Rate: ${formatPercent(result.summary.passRate)}`,
	];

	if (comparison?.summary) {
		lines.push(renderComparisonLine('Pass Rate', comparison.summary.passRate));
		lines.push(renderNumberComparisonLine('Failed Cases', comparison.summary.failedCases));
	}

	return lines;
}

function updateBaselineSections(baselineRoot: Record<string, unknown>, results: EvalResults): string[] {
	const updatedSuites: string[] = [];
	if (results.extraction) {
		baselineRoot.extraction = results.extraction;
		updatedSuites.push('extraction');
	}
	if (results.segmentation) {
		baselineRoot.segmentation = results.segmentation;
		updatedSuites.push('segmentation');
	}
	if (results.entities) {
		baselineRoot.entities = results.entities;
		updatedSuites.push('entities');
	}
	if (results.qualityRouting) {
		baselineRoot.qualityRouting = results.qualityRouting;
		updatedSuites.push('qualityRouting');
	}
	if (results.assertions) {
		baselineRoot.assertions = results.assertions;
		updatedSuites.push('assertions');
	}
	writeBaselineRoot(baselineRoot);
	return updatedSuites;
}

function renderExtractionReportSection(result: ExtractionEvalResult, comparison?: ExtractionComparison): string[] {
	return renderExtractionReport(result, comparison);
}

function renderSegmentationReportSection(
	result: SegmentationEvalResult,
	comparison?: SegmentationComparison,
): string[] {
	return renderSegmentationReport(result, comparison);
}

function renderEntityReportSection(result: EntityEvalResult, comparison?: EntityComparison): string[] {
	return renderEntityReport(result, comparison);
}

export function runEvalCommand(options: EvalCommandOptions): EvalCommandResult {
	assertValidCompare(options.compare);
	const selection = normalizeStep(options.step);
	const baselineRoot = options.compare || options.updateBaseline ? loadBaselineRoot(Boolean(options.compare)) : {};
	const results: EvalResults = {};

	for (const suite of selection.suites) {
		switch (suite) {
			case 'extraction':
				results.extraction = runExtractionEval(
					resolve(GOLDEN_ROOT, 'extraction'),
					resolve(REPO_ROOT, 'fixtures/extracted'),
				);
				break;
			case 'segmentation':
				results.segmentation = runSegmentationEval(
					resolve(GOLDEN_ROOT, 'segmentation'),
					resolve(REPO_ROOT, 'fixtures/segments'),
				);
				break;
			case 'entities':
				results.entities = runEntityEval(resolve(GOLDEN_ROOT, 'entities'), resolve(REPO_ROOT, 'fixtures/entities'));
				break;
			case 'qualityRouting':
				results.qualityRouting = runQualityRoutingEval(
					resolve(GOLDEN_ROOT, 'quality-routing'),
					resolve(REPO_ROOT, 'fixtures/quality-routing'),
				);
				break;
			case 'assertions':
				results.assertions = runAssertionClassificationEval(
					resolve(GOLDEN_ROOT, 'assertions'),
					resolve(REPO_ROOT, 'fixtures/assertions'),
				);
				break;
		}
	}

	const comparison = options.compare ? buildComparison(results, baselineRoot, selection.suites) : undefined;
	let baselineUpdated = false;
	if (options.updateBaseline) {
		updateBaselineSections(baselineRoot, results);
		baselineUpdated = true;
	}

	return {
		step: selection.step,
		results,
		comparison,
		baselineUpdated,
	};
}

export function renderEvalCommand(result: EvalCommandResult): string {
	const lines: string[] = [];
	const appendSection = (report: string[]): void => {
		if (report.length === 0) {
			return;
		}

		if (lines.length > 0) {
			lines.push('');
		}

		lines.push(...report);
	};

	if (result.results.extraction) {
		appendSection(renderExtractionReportSection(result.results.extraction, result.comparison?.suites.extraction));
	}

	if (result.results.segmentation) {
		appendSection(renderSegmentationReportSection(result.results.segmentation, result.comparison?.suites.segmentation));
	}

	if (result.results.entities) {
		appendSection(renderEntityReportSection(result.results.entities, result.comparison?.suites.entities));
	}

	if (result.results.qualityRouting) {
		appendSection(
			renderFixtureSuiteReport(
				'Quality Routing',
				result.results.qualityRouting,
				result.comparison?.suites.qualityRouting,
			),
		);
	}

	if (result.results.assertions) {
		appendSection(
			renderFixtureSuiteReport(
				'Assertion Classification',
				result.results.assertions,
				result.comparison?.suites.assertions,
			),
		);
	}

	if (result.baselineUpdated) {
		const updatedSuites = Object.keys(result.results).join(', ');
		lines.push('', `Baseline updated for suites: ${updatedSuites}`);
	}

	return `${lines.join('\n')}\n`;
}
