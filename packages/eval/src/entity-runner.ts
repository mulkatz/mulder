/**
 * Entity eval runner: loads golden entity annotations, compares against
 * entity extraction fixture output, and produces aggregate results.
 *
 * @see docs/specs/31_golden_test_set_segmentation_entities.spec.md §4.6
 * @see docs/functional-spec.md §15.1
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractedEntity, ExtractedRelationship, ExtractionResponse } from '@mulder/pipeline';
import { computeEntityPrecisionRecallF1 } from './entity-metrics.js';
import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import { computeRelationshipPrecisionRecallF1 } from './relationship-metrics.js';
import type { EntityEvalResult, EntityGolden, EntityMetricResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Golden set loading
// ────────────────────────────────────────────────────────────

/**
 * Validate that a parsed JSON object has the required EntityGolden shape.
 * Throws MulderEvalError with GOLDEN_INVALID code if validation fails.
 */
function validateEntityGolden(data: unknown, filePath: string): EntityGolden {
	if (typeof data !== 'object' || data === null) {
		throw new MulderEvalError(`Golden file is not a JSON object: ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
			context: { filePath },
		});
	}

	const obj = data as Record<string, unknown>;

	if (typeof obj.segmentId !== 'string') {
		throw new MulderEvalError(
			`Golden file missing or invalid 'segmentId': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (typeof obj.sourceSlug !== 'string') {
		throw new MulderEvalError(
			`Golden file missing or invalid 'sourceSlug': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	const validDifficulties = ['simple', 'moderate', 'complex'];
	if (typeof obj.difficulty !== 'string' || !validDifficulties.includes(obj.difficulty)) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'difficulty': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: obj.difficulty } },
		);
	}

	if (!Array.isArray(obj.languages) || obj.languages.length === 0) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'languages': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (!Array.isArray(obj.expectedEntities)) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'expectedEntities': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (!Array.isArray(obj.expectedRelationships)) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'expectedRelationships': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (typeof obj.annotation !== 'object' || obj.annotation === null) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'annotation': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	const annotation = obj.annotation as Record<string, unknown>;
	if (typeof annotation.author !== 'string' || typeof annotation.date !== 'string') {
		throw new MulderEvalError(
			`Golden file 'annotation' missing 'author' or 'date': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	return data as EntityGolden;
}

/**
 * Load all entity golden annotations from a directory.
 *
 * Reads all *.json files, parses and validates structure,
 * returns sorted by segmentId.
 */
export function loadEntityGoldenSet(goldenDir: string): EntityGolden[] {
	if (!existsSync(goldenDir)) {
		throw new MulderEvalError(
			`Entity golden directory does not exist: ${goldenDir}`,
			EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY,
			{ context: { goldenDir } },
		);
	}

	const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json'));

	if (files.length === 0) {
		throw new MulderEvalError(
			`Entity golden directory contains no JSON files: ${goldenDir}`,
			EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY,
			{ context: { goldenDir } },
		);
	}

	const goldens: EntityGolden[] = [];

	for (const file of files) {
		const filePath = join(goldenDir, file);
		const raw = readFileSync(filePath, 'utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new MulderEvalError(`Failed to parse entity golden JSON: ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
				context: { filePath },
				cause,
			});
		}

		goldens.push(validateEntityGolden(parsed, filePath));
	}

	goldens.sort((a, b) => a.segmentId.localeCompare(b.segmentId));
	return goldens;
}

// ────────────────────────────────────────────────────────────
// Entity fixture loading
// ────────────────────────────────────────────────────────────

/**
 * Load actual entities from an entity fixture file.
 */
export function loadActualEntities(
	entitiesDir: string,
	segmentId: string,
): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] } {
	const filePath = join(entitiesDir, `${segmentId}.entities.json`);

	if (!existsSync(filePath)) {
		throw new MulderEvalError(`Entity fixture not found: ${filePath}`, EVAL_ERROR_CODES.FIXTURE_NOT_FOUND, {
			context: { filePath, segmentId },
		});
	}

	let parsed: unknown;
	try {
		const raw = readFileSync(filePath, 'utf-8');
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new MulderEvalError(
			`Failed to parse entity fixture: ${filePath}`,
			EVAL_ERROR_CODES.ENTITY_FIXTURE_PARSE_ERROR,
			{ context: { filePath, segmentId }, cause },
		);
	}

	const response = parsed as ExtractionResponse;
	return {
		entities: response.entities ?? [],
		relationships: response.relationships ?? [],
	};
}

// ────────────────────────────────────────────────────────────
// Eval runner
// ────────────────────────────────────────────────────────────

/**
 * Run entity eval: load golden set, compare against entity fixtures,
 * produce aggregate results.
 *
 * @param goldenDir - Path to eval/golden/entities/
 * @param entitiesDir - Path to fixtures/entities/
 * @returns Full eval result with per-segment metrics and summary
 */
export function runEntityEval(goldenDir: string, entitiesDir: string): EntityEvalResult {
	const goldens = loadEntityGoldenSet(goldenDir);
	const segments: EntityMetricResult[] = [];

	for (const golden of goldens) {
		const actual = loadActualEntities(entitiesDir, golden.segmentId);
		const entityMetrics = computeEntityPrecisionRecallF1(golden.expectedEntities, actual.entities);
		const relMetrics = computeRelationshipPrecisionRecallF1(golden.expectedRelationships, actual.relationships);

		segments.push({
			segmentId: golden.segmentId,
			sourceSlug: golden.sourceSlug,
			difficulty: golden.difficulty,
			byType: entityMetrics.byType,
			overall: entityMetrics.overall,
			relationships: relMetrics,
		});
	}

	// Compute summary
	const totalSegments = segments.length;

	// Per-type averages
	const typeAggregates: Record<
		string,
		{ totalPrecision: number; totalRecall: number; totalF1: number; count: number }
	> = {};
	for (const seg of segments) {
		for (const [type, metrics] of Object.entries(seg.byType)) {
			const existing = typeAggregates[type];
			if (existing) {
				existing.totalPrecision += metrics.precision;
				existing.totalRecall += metrics.recall;
				existing.totalF1 += metrics.f1;
				existing.count += 1;
			} else {
				typeAggregates[type] = {
					totalPrecision: metrics.precision,
					totalRecall: metrics.recall,
					totalF1: metrics.f1,
					count: 1,
				};
			}
		}
	}

	const byType: Record<string, { avgPrecision: number; avgRecall: number; avgF1: number; count: number }> = {};
	for (const [type, agg] of Object.entries(typeAggregates)) {
		byType[type] = {
			avgPrecision: agg.totalPrecision / agg.count,
			avgRecall: agg.totalRecall / agg.count,
			avgF1: agg.totalF1 / agg.count,
			count: agg.count,
		};
	}

	// Overall averages
	const overall: { avgPrecision: number; avgRecall: number; avgF1: number } = {
		avgPrecision: totalSegments > 0 ? segments.reduce((sum, s) => sum + s.overall.precision, 0) / totalSegments : 0,
		avgRecall: totalSegments > 0 ? segments.reduce((sum, s) => sum + s.overall.recall, 0) / totalSegments : 0,
		avgF1: totalSegments > 0 ? segments.reduce((sum, s) => sum + s.overall.f1, 0) / totalSegments : 0,
	};

	// Relationship averages
	const relationships: { avgPrecision: number; avgRecall: number; avgF1: number } = {
		avgPrecision:
			totalSegments > 0 ? segments.reduce((sum, s) => sum + s.relationships.precision, 0) / totalSegments : 0,
		avgRecall: totalSegments > 0 ? segments.reduce((sum, s) => sum + s.relationships.recall, 0) / totalSegments : 0,
		avgF1: totalSegments > 0 ? segments.reduce((sum, s) => sum + s.relationships.f1, 0) / totalSegments : 0,
	};

	// By difficulty
	const diffAggregates: Record<string, { totalF1: number; count: number }> = {};
	for (const seg of segments) {
		const existing = diffAggregates[seg.difficulty];
		if (existing) {
			existing.totalF1 += seg.overall.f1;
			existing.count += 1;
		} else {
			diffAggregates[seg.difficulty] = {
				totalF1: seg.overall.f1,
				count: 1,
			};
		}
	}

	const byDifficulty: Record<string, { avgF1: number; count: number }> = {};
	for (const [diff, agg] of Object.entries(diffAggregates)) {
		byDifficulty[diff] = {
			avgF1: agg.totalF1 / agg.count,
			count: agg.count,
		};
	}

	return {
		timestamp: new Date().toISOString(),
		segments,
		summary: {
			totalSegments,
			byType,
			overall,
			relationships,
			byDifficulty,
		},
	};
}
