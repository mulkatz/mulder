/**
 * Assertion-classification eval runner: validates golden assertion annotations,
 * compares fixture-backed extracted assertions, and reports deterministic pass
 * and coverage metrics without live LLM, database, or storage access.
 *
 * @see docs/specs/106_golden_tests_quality_routing_assertion_classification.spec.md
 * @see docs/functional-spec-addendum.md §A3
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import type {
	ActualAssertionCase,
	AssertionClassificationCaseResult,
	AssertionClassificationEvalResult,
	AssertionClassificationGolden,
	AssertionConfidenceMetadata,
	AssertionType,
	ClassificationProvenance,
	EvalMismatch,
} from './types.js';

const DETERMINISTIC_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const DIFFICULTIES = ['simple', 'moderate', 'complex'] as const;
const ASSERTION_TYPES = ['observation', 'interpretation', 'hypothesis'] as const;
const CLASSIFICATION_PROVENANCES = ['llm_auto', 'human_reviewed', 'author_explicit'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
	return typeof value === 'string' && allowed.includes(value);
}

function assertPlainObject(value: unknown, filePath: string, field: string): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw new MulderEvalError(
			`Assertion file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return value;
}

function assertString(value: unknown, filePath: string, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new MulderEvalError(
			`Assertion file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return value;
}

function assertBoolean(value: unknown, filePath: string, field: string): boolean {
	if (typeof value !== 'boolean') {
		throw new MulderEvalError(
			`Assertion file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return value;
}

function assertStringArray(value: unknown, filePath: string, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new MulderEvalError(
			`Assertion file missing or invalid '${field}': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, field } },
		);
	}

	return [...value].sort((left, right) => left.localeCompare(right));
}

function validateConfidenceMetadata(value: unknown, filePath: string): AssertionConfidenceMetadata {
	const metadata = assertPlainObject(value, filePath, 'confidenceMetadata');
	const witnessCount = metadata.witness_count;
	if (witnessCount !== null && (typeof witnessCount !== 'number' || Number.isNaN(witnessCount))) {
		throw new MulderEvalError(
			`Assertion file has invalid confidenceMetadata.witness_count: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: witnessCount } },
		);
	}

	return {
		witness_count: witnessCount,
		measurement_based: assertBoolean(metadata.measurement_based, filePath, 'confidenceMetadata.measurement_based'),
		contemporaneous: assertBoolean(metadata.contemporaneous, filePath, 'confidenceMetadata.contemporaneous'),
		corroborated: assertBoolean(metadata.corroborated, filePath, 'confidenceMetadata.corroborated'),
		peer_reviewed: assertBoolean(metadata.peer_reviewed, filePath, 'confidenceMetadata.peer_reviewed'),
		author_is_interpreter: assertBoolean(
			metadata.author_is_interpreter,
			filePath,
			'confidenceMetadata.author_is_interpreter',
		),
	};
}

function validateExpectedAssertion(value: unknown, filePath: string): AssertionClassificationGolden['expected'] {
	const expected = assertPlainObject(value, filePath, 'expected');
	const assertionType = expected.assertionType;
	const classificationProvenance = expected.classificationProvenance;

	if (!isOneOf(assertionType, ASSERTION_TYPES)) {
		throw new MulderEvalError(
			`Assertion golden has invalid expected.assertionType: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: assertionType } },
		);
	}

	if (!isOneOf(classificationProvenance, CLASSIFICATION_PROVENANCES)) {
		throw new MulderEvalError(
			`Assertion golden has invalid expected.classificationProvenance: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: classificationProvenance } },
		);
	}

	return {
		content: assertString(expected.content, filePath, 'expected.content'),
		assertionType,
		classificationProvenance,
		confidenceMetadata: validateConfidenceMetadata(expected.confidenceMetadata, filePath),
		...(expected.entityNames === undefined
			? {}
			: { entityNames: assertStringArray(expected.entityNames, filePath, 'expected.entityNames') }),
		...(expected.qualityMetadata === undefined
			? {}
			: { qualityMetadata: assertPlainObject(expected.qualityMetadata, filePath, 'expected.qualityMetadata') }),
	};
}

function validateAnnotation(value: unknown, filePath: string): AssertionClassificationGolden['annotation'] {
	const annotation = assertPlainObject(value, filePath, 'annotation');
	return {
		author: assertString(annotation.author, filePath, 'annotation.author'),
		date: assertString(annotation.date, filePath, 'annotation.date'),
		...(typeof annotation.notes === 'string' ? { notes: annotation.notes } : {}),
	};
}

function validateAssertionGolden(data: unknown, filePath: string): AssertionClassificationGolden {
	const obj = assertPlainObject(data, filePath, 'root');
	const difficulty = obj.difficulty;
	if (!isOneOf(difficulty, DIFFICULTIES)) {
		throw new MulderEvalError(
			`Assertion golden missing or invalid 'difficulty': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: difficulty } },
		);
	}

	return {
		caseId: assertString(obj.caseId, filePath, 'caseId'),
		segmentId: assertString(obj.segmentId, filePath, 'segmentId'),
		sourceSlug: assertString(obj.sourceSlug, filePath, 'sourceSlug'),
		difficulty,
		expected: validateExpectedAssertion(obj.expected, filePath),
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

export function loadAssertionGoldenSet(goldenDir: string): AssertionClassificationGolden[] {
	return listJsonFiles(goldenDir, 'Assertion golden')
		.map((file) => {
			const filePath = join(goldenDir, file);
			return validateAssertionGolden(parseJsonFile(filePath, 'assertion golden'), filePath);
		})
		.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function validateActualAssertionCase(data: unknown, filePath: string): ActualAssertionCase {
	const obj = assertPlainObject(data, filePath, 'root');
	const assertion = assertPlainObject(obj.assertion, filePath, 'assertion');
	const assertionType = assertion.assertion_type;
	const classificationProvenance = assertion.classification_provenance;

	if (!isOneOf(assertionType, ASSERTION_TYPES)) {
		throw new MulderEvalError(
			`Assertion fixture has invalid assertion.assertion_type: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: assertionType } },
		);
	}

	if (!isOneOf(classificationProvenance, CLASSIFICATION_PROVENANCES)) {
		throw new MulderEvalError(
			`Assertion fixture has invalid assertion.classification_provenance: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: classificationProvenance } },
		);
	}

	return {
		caseId: assertString(obj.caseId, filePath, 'caseId'),
		segmentId: assertString(obj.segmentId, filePath, 'segmentId'),
		sourceSlug: assertString(obj.sourceSlug, filePath, 'sourceSlug'),
		assertion: {
			content: assertString(assertion.content, filePath, 'assertion.content'),
			assertion_type: assertionType,
			classification_provenance: classificationProvenance,
			confidence_metadata: validateConfidenceMetadata(assertion.confidence_metadata, filePath),
			...(assertion.entity_names === undefined
				? {}
				: { entity_names: assertStringArray(assertion.entity_names, filePath, 'assertion.entity_names') }),
			...(assertion.quality_metadata === undefined
				? {}
				: { quality_metadata: assertPlainObject(assertion.quality_metadata, filePath, 'assertion.quality_metadata') }),
		},
	};
}

export function loadActualAssertionCases(fixturesDir: string): ActualAssertionCase[] {
	return listJsonFiles(fixturesDir, 'Assertion fixture')
		.map((file) => {
			const filePath = join(fixturesDir, file);
			return validateActualAssertionCase(parseJsonFile(filePath, 'assertion fixture'), filePath);
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

function scoreAssertionCase(
	golden: AssertionClassificationGolden,
	actual: ActualAssertionCase,
): AssertionClassificationCaseResult {
	const mismatches: EvalMismatch[] = [];
	const expected = golden.expected;
	const assertion = actual.assertion;
	const checks = {
		content: addMismatch(mismatches, 'content', expected.content, assertion.content),
		assertionType: addMismatch(mismatches, 'assertionType', expected.assertionType, assertion.assertion_type),
		classificationProvenance: addMismatch(
			mismatches,
			'classificationProvenance',
			expected.classificationProvenance,
			assertion.classification_provenance,
		),
		confidenceMetadata: addMismatch(
			mismatches,
			'confidenceMetadata',
			expected.confidenceMetadata,
			assertion.confidence_metadata,
		),
		entityNames: addMismatch(mismatches, 'entityNames', expected.entityNames ?? [], assertion.entity_names ?? []),
		qualityMetadata: addMismatch(
			mismatches,
			'qualityMetadata',
			expected.qualityMetadata ?? {},
			assertion.quality_metadata ?? {},
		),
	};

	return {
		caseId: golden.caseId,
		segmentId: golden.segmentId,
		sourceSlug: golden.sourceSlug,
		difficulty: golden.difficulty,
		assertionType: assertion.assertion_type,
		classificationProvenance: assertion.classification_provenance,
		passed: mismatches.length === 0,
		checks,
		mismatches,
	};
}

function emptyAssertionCoverage(): Record<AssertionType, number> {
	return {
		observation: 0,
		interpretation: 0,
		hypothesis: 0,
	};
}

export function runAssertionClassificationEval(
	goldenDir: string,
	fixturesDir: string,
): AssertionClassificationEvalResult {
	const goldens = loadAssertionGoldenSet(goldenDir);
	const actualCases = loadActualAssertionCases(fixturesDir);
	const actualByCaseId = new Map(actualCases.map((actual) => [actual.caseId, actual]));
	const cases: AssertionClassificationCaseResult[] = [];

	for (const golden of goldens) {
		const actual = actualByCaseId.get(golden.caseId);
		if (!actual) {
			throw new MulderEvalError(
				`Assertion fixture not found for case: ${golden.caseId}`,
				EVAL_ERROR_CODES.FIXTURE_NOT_FOUND,
				{
					context: { caseId: golden.caseId, fixturesDir },
				},
			);
		}

		cases.push(scoreAssertionCase(golden, actual));
	}

	const byAssertionType = emptyAssertionCoverage();
	const byProvenance: Partial<Record<ClassificationProvenance, number>> = {};
	for (const golden of goldens) {
		byAssertionType[golden.expected.assertionType] += 1;
		byProvenance[golden.expected.classificationProvenance] =
			(byProvenance[golden.expected.classificationProvenance] ?? 0) + 1;
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
			coverage: {
				byAssertionType,
				byProvenance,
			},
		},
	};
}
