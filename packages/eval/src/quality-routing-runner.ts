/**
 * Quality-routing eval runner: validates golden routing annotations, compares
 * them against fixture-backed quality assessment output, and reports pass and
 * coverage metrics without touching live services.
 *
 * @see docs/specs/106_golden_tests_quality_routing_assertion_classification.spec.md
 * @see docs/functional-spec-addendum.md §A4
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import type {
	ActualQualityRoutingCase,
	DocumentOverallQuality,
	EvalMismatch,
	ExtractionPath,
	QualityRoutingCaseResult,
	QualityRoutingEvalResult,
	QualityRoutingGolden,
} from './types.js';

const DETERMINISTIC_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const DIFFICULTIES = ['simple', 'moderate', 'complex'] as const;
const OVERALL_QUALITIES = ['high', 'medium', 'low', 'unusable'] as const;
const EXTRACTION_PATHS = [
	'standard',
	'enhanced_ocr',
	'visual_extraction',
	'handwriting_recognition',
	'manual_transcription_required',
	'skip',
] as const;
const GATE_OUTCOMES = ['allow', 'skip'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
	return typeof value === 'string' && allowed.includes(value);
}

function assertPlainObject(value: unknown, filePath: string, field: string): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw new MulderEvalError(
			`Quality routing file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return value;
}

function assertString(value: unknown, filePath: string, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new MulderEvalError(
			`Quality routing file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return value;
}

function assertBoolean(value: unknown, filePath: string, field: string): boolean {
	if (typeof value !== 'boolean') {
		throw new MulderEvalError(
			`Quality routing file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return value;
}

function assertNumber(value: unknown, filePath: string, field: string): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new MulderEvalError(
			`Quality routing file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return value;
}

function validateQualityMetadata(
	value: unknown,
	filePath: string,
): QualityRoutingGolden['expected']['qualityMetadata'] {
	const metadata = assertPlainObject(value, filePath, 'qualityMetadata');
	const sourceQuality = metadata.source_document_quality;
	if (!isOneOf(sourceQuality, ['high', 'medium', 'low'] as const)) {
		throw new MulderEvalError(
			`Quality routing file has invalid qualityMetadata.source_document_quality: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: sourceQuality } },
		);
	}

	const extractionPath = metadata.extraction_path;
	if (!isOneOf(extractionPath, EXTRACTION_PATHS)) {
		throw new MulderEvalError(
			`Quality routing file has invalid qualityMetadata.extraction_path: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: extractionPath } },
		);
	}

	return {
		source_document_quality: sourceQuality,
		extraction_path: extractionPath,
		extraction_confidence: assertNumber(
			metadata.extraction_confidence,
			filePath,
			'qualityMetadata.extraction_confidence',
		),
	};
}

function validateExpectedQuality(value: unknown, filePath: string): QualityRoutingGolden['expected'] {
	const expected = assertPlainObject(value, filePath, 'expected');
	const overallQuality = expected.overallQuality;
	if (!isOneOf(overallQuality, OVERALL_QUALITIES)) {
		throw new MulderEvalError(
			`Quality routing file has invalid expected.overallQuality: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: overallQuality } },
		);
	}

	const recommendedPath = expected.recommendedPath;
	if (!isOneOf(recommendedPath, EXTRACTION_PATHS)) {
		throw new MulderEvalError(
			`Quality routing file has invalid expected.recommendedPath: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: recommendedPath } },
		);
	}

	const extractionGateOutcome = expected.extractionGateOutcome;
	if (!isOneOf(extractionGateOutcome, GATE_OUTCOMES)) {
		throw new MulderEvalError(
			`Quality routing file has invalid expected.extractionGateOutcome: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: extractionGateOutcome } },
		);
	}

	return {
		overallQuality,
		processable: assertBoolean(expected.processable, filePath, 'expected.processable'),
		recommendedPath,
		extractionGateOutcome,
		qualityMetadata: validateQualityMetadata(expected.qualityMetadata, filePath),
		signals: assertPlainObject(expected.signals, filePath, 'expected.signals'),
	};
}

function validateAnnotation(value: unknown, filePath: string): QualityRoutingGolden['annotation'] {
	const annotation = assertPlainObject(value, filePath, 'annotation');
	return {
		author: assertString(annotation.author, filePath, 'annotation.author'),
		date: assertString(annotation.date, filePath, 'annotation.date'),
		...(typeof annotation.notes === 'string' ? { notes: annotation.notes } : {}),
	};
}

function validateQualityRoutingGolden(data: unknown, filePath: string): QualityRoutingGolden {
	const obj = assertPlainObject(data, filePath, 'root');
	const difficulty = obj.difficulty;
	if (!isOneOf(difficulty, DIFFICULTIES)) {
		throw new MulderEvalError(
			`Quality routing file missing or invalid 'difficulty': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: difficulty } },
		);
	}

	return {
		caseId: assertString(obj.caseId, filePath, 'caseId'),
		sourceSlug: assertString(obj.sourceSlug, filePath, 'sourceSlug'),
		difficulty,
		expected: validateExpectedQuality(obj.expected, filePath),
		annotation: validateAnnotation(obj.annotation, filePath),
	};
}

function parseJsonFile(filePath: string, label: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, 'utf-8'));
	} catch (cause) {
		throw new MulderEvalError(`Failed to parse ${label} JSON: ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
			context: { filePath },
			cause,
		});
	}
}

function listJsonFiles(dir: string, label: string): string[] {
	if (!existsSync(dir)) {
		throw new MulderEvalError(`${label} directory does not exist: ${dir}`, EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY, {
			context: { dir },
		});
	}

	const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
	if (files.length === 0) {
		throw new MulderEvalError(`${label} directory contains no JSON files: ${dir}`, EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY, {
			context: { dir },
		});
	}

	return files.sort((left, right) => left.localeCompare(right));
}

export function loadQualityRoutingGoldenSet(goldenDir: string): QualityRoutingGolden[] {
	return listJsonFiles(goldenDir, 'Quality routing golden')
		.map((file) => {
			const filePath = join(goldenDir, file);
			return validateQualityRoutingGolden(parseJsonFile(filePath, 'quality routing golden'), filePath);
		})
		.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function validateActualQualityCase(data: unknown, filePath: string): ActualQualityRoutingCase {
	const obj = assertPlainObject(data, filePath, 'root');
	const assessment = assertPlainObject(obj.assessment, filePath, 'assessment');
	const extractionGate = assertPlainObject(obj.extractionGate, filePath, 'extractionGate');
	const overallQuality = assessment.overallQuality;
	const recommendedPath = assessment.recommendedPath;
	const outcome = extractionGate.outcome;

	if (!isOneOf(overallQuality, OVERALL_QUALITIES)) {
		throw new MulderEvalError(
			`Quality routing fixture has invalid assessment.overallQuality: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: overallQuality } },
		);
	}

	if (!isOneOf(recommendedPath, EXTRACTION_PATHS)) {
		throw new MulderEvalError(
			`Quality routing fixture has invalid assessment.recommendedPath: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: recommendedPath } },
		);
	}

	if (!isOneOf(outcome, GATE_OUTCOMES)) {
		throw new MulderEvalError(
			`Quality routing fixture has invalid extractionGate.outcome: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: outcome } },
		);
	}

	return {
		caseId: assertString(obj.caseId, filePath, 'caseId'),
		sourceSlug: assertString(obj.sourceSlug, filePath, 'sourceSlug'),
		assessment: {
			overallQuality,
			processable: assertBoolean(assessment.processable, filePath, 'assessment.processable'),
			recommendedPath,
			signals: assertPlainObject(assessment.signals, filePath, 'assessment.signals'),
		},
		extractionGate: { outcome },
		qualityMetadata: validateQualityMetadata(obj.qualityMetadata, filePath),
	};
}

export function loadActualQualityRoutingCases(fixturesDir: string): ActualQualityRoutingCase[] {
	return listJsonFiles(fixturesDir, 'Quality routing fixture')
		.map((file) => {
			const filePath = join(fixturesDir, file);
			return validateActualQualityCase(parseJsonFile(filePath, 'quality routing fixture'), filePath);
		})
		.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}

	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}

		return left.every((value, index) => valuesEqual(value, right[index]));
	}

	if (!isPlainObject(left) || !isPlainObject(right)) {
		return false;
	}

	const leftKeys = Object.keys(left).sort((a, b) => a.localeCompare(b));
	const rightKeys = Object.keys(right).sort((a, b) => a.localeCompare(b));
	return valuesEqual(leftKeys, rightKeys) && leftKeys.every((key) => valuesEqual(left[key], right[key]));
}

function addMismatch(mismatches: EvalMismatch[], field: string, expected: unknown, actual: unknown): boolean {
	const matches = valuesEqual(expected, actual);
	if (!matches) {
		mismatches.push({ field, expected, actual });
	}

	return matches;
}

function scoreQualityCase(golden: QualityRoutingGolden, actual: ActualQualityRoutingCase): QualityRoutingCaseResult {
	const mismatches: EvalMismatch[] = [];
	const checks = {
		overallQuality: addMismatch(
			mismatches,
			'overallQuality',
			golden.expected.overallQuality,
			actual.assessment.overallQuality,
		),
		processable: addMismatch(mismatches, 'processable', golden.expected.processable, actual.assessment.processable),
		recommendedPath: addMismatch(
			mismatches,
			'recommendedPath',
			golden.expected.recommendedPath,
			actual.assessment.recommendedPath,
		),
		extractionGateOutcome: addMismatch(
			mismatches,
			'extractionGate.outcome',
			golden.expected.extractionGateOutcome,
			actual.extractionGate.outcome,
		),
		qualityMetadata: addMismatch(
			mismatches,
			'qualityMetadata',
			golden.expected.qualityMetadata,
			actual.qualityMetadata,
		),
		signals: addMismatch(mismatches, 'signals', golden.expected.signals, actual.assessment.signals),
	};

	return {
		caseId: golden.caseId,
		sourceSlug: golden.sourceSlug,
		difficulty: golden.difficulty,
		overallQuality: actual.assessment.overallQuality,
		recommendedPath: actual.assessment.recommendedPath,
		processable: actual.assessment.processable,
		passed: mismatches.length === 0,
		checks,
		mismatches,
	};
}

function emptyQualityCoverage(): Record<DocumentOverallQuality, number> {
	return {
		high: 0,
		medium: 0,
		low: 0,
		unusable: 0,
	};
}

export function runQualityRoutingEval(goldenDir: string, fixturesDir: string): QualityRoutingEvalResult {
	const goldens = loadQualityRoutingGoldenSet(goldenDir);
	const actualCases = loadActualQualityRoutingCases(fixturesDir);
	const actualByCaseId = new Map(actualCases.map((actual) => [actual.caseId, actual]));
	const cases: QualityRoutingCaseResult[] = [];

	for (const golden of goldens) {
		const actual = actualByCaseId.get(golden.caseId);
		if (!actual) {
			throw new MulderEvalError(
				`Quality routing fixture not found for case: ${golden.caseId}`,
				EVAL_ERROR_CODES.FIXTURE_NOT_FOUND,
				{
					context: { caseId: golden.caseId, fixturesDir },
				},
			);
		}

		cases.push(scoreQualityCase(golden, actual));
	}

	const coverage = {
		byQuality: emptyQualityCoverage(),
		byRoute: {} as Partial<Record<ExtractionPath, number>>,
	};

	for (const golden of goldens) {
		coverage.byQuality[golden.expected.overallQuality] += 1;
		coverage.byRoute[golden.expected.recommendedPath] = (coverage.byRoute[golden.expected.recommendedPath] ?? 0) + 1;
	}

	const totalCases = cases.length;
	const passedCases = cases.filter((result) => result.passed).length;
	const failedCases = totalCases - passedCases;

	return {
		timestamp: DETERMINISTIC_TIMESTAMP,
		cases,
		summary: {
			totalCases,
			passedCases,
			failedCases,
			passRate: totalCases > 0 ? passedCases / totalCases : 0,
			coverage,
		},
	};
}
