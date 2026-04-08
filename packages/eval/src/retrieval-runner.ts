/**
 * Retrieval eval runner: loads golden queries from `eval/golden/retrieval/`,
 * takes a callback that executes each query against the system under test,
 * and produces aggregate metrics.
 *
 * The runner deliberately does NOT import `@mulder/retrieval`. Callers supply
 * their own `runQuery` function — typically one that wraps `hybridRetrieve`
 * against a real database in a test harness. This keeps the eval package
 * free of retrieval-layer dependencies and usable from both Vitest specs and
 * standalone scripts.
 *
 * @see docs/functional-spec.md §5 (hybrid retrieval)
 * @see docs/functional-spec.md §15 (quality evaluation)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import { computeMRR, computeNDCG10, computeRetrievalMetricsAtK, countPrimaryRecall } from './retrieval-metrics.js';
import type {
	ActualRetrievalHit,
	RetrievalEvalResult,
	RetrievalGolden,
	RetrievalMetricAtK,
	RetrievalMetricResult,
	RetrievalQueryType,
} from './types.js';

// ────────────────────────────────────────────────────────────
// Golden set loading
// ────────────────────────────────────────────────────────────

const VALID_QUERY_TYPES: ReadonlySet<RetrievalQueryType> = new Set([
	'factual',
	'exploratory',
	'relational',
	'negative',
]);

const VALID_DIFFICULTIES: ReadonlySet<string> = new Set(['simple', 'moderate', 'complex']);
const VALID_LANGUAGES: ReadonlySet<string> = new Set(['de', 'en']);
const VALID_RELEVANCE: ReadonlySet<string> = new Set(['primary', 'secondary', 'tangential']);

/**
 * Validate that a parsed JSON object has the required `RetrievalGolden` shape.
 * Throws `MulderEvalError` with `GOLDEN_INVALID` code on the first failure.
 *
 * The validation is intentionally verbose — it surfaces exactly which field
 * is wrong in which file so golden authors get actionable errors.
 */
function validateRetrievalGolden(data: unknown, filePath: string): RetrievalGolden {
	if (typeof data !== 'object' || data === null) {
		throw new MulderEvalError(
			`Retrieval golden file is not a JSON object: ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	const obj = data as Record<string, unknown>;

	if (typeof obj.queryId !== 'string' || obj.queryId.length === 0) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'queryId': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (typeof obj.queryText !== 'string' || obj.queryText.length === 0) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'queryText': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, queryId: obj.queryId } },
		);
	}

	if (typeof obj.language !== 'string' || !VALID_LANGUAGES.has(obj.language)) {
		throw new MulderEvalError(
			`Golden file has invalid 'language' (must be 'de' or 'en'): ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: obj.language } },
		);
	}

	if (typeof obj.queryType !== 'string' || !VALID_QUERY_TYPES.has(obj.queryType as RetrievalQueryType)) {
		throw new MulderEvalError(
			`Golden file has invalid 'queryType' (must be one of factual|exploratory|relational|negative): ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: obj.queryType } },
		);
	}

	if (typeof obj.difficulty !== 'string' || !VALID_DIFFICULTIES.has(obj.difficulty)) {
		throw new MulderEvalError(`Golden file has invalid 'difficulty': ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
			context: { filePath, value: obj.difficulty },
		});
	}

	if (!Array.isArray(obj.expectedHits)) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'expectedHits' (must be array): ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	// Allow empty array only for negative queries.
	if (obj.expectedHits.length === 0 && obj.queryType !== 'negative') {
		throw new MulderEvalError(
			`Golden file has empty 'expectedHits' but queryType is not 'negative': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	for (const [i, rawHit] of obj.expectedHits.entries()) {
		if (typeof rawHit !== 'object' || rawHit === null) {
			throw new MulderEvalError(
				`Golden file 'expectedHits[${i}]' is not an object: ${filePath}`,
				EVAL_ERROR_CODES.GOLDEN_INVALID,
				{ context: { filePath, index: i } },
			);
		}
		const hit = rawHit as Record<string, unknown>;
		if (typeof hit.contentContains !== 'string' || hit.contentContains.length === 0) {
			throw new MulderEvalError(
				`Golden file 'expectedHits[${i}].contentContains' is missing or empty: ${filePath}`,
				EVAL_ERROR_CODES.GOLDEN_INVALID,
				{ context: { filePath, index: i } },
			);
		}
		if (typeof hit.relevance !== 'string' || !VALID_RELEVANCE.has(hit.relevance)) {
			throw new MulderEvalError(
				`Golden file 'expectedHits[${i}].relevance' must be one of primary|secondary|tangential: ${filePath}`,
				EVAL_ERROR_CODES.GOLDEN_INVALID,
				{ context: { filePath, index: i, value: hit.relevance } },
			);
		}
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

	return data as RetrievalGolden;
}

/**
 * Load all retrieval golden annotations from a directory. Returns queries
 * sorted by `queryId` for deterministic reporting.
 */
export function loadRetrievalGoldenSet(goldenDir: string): RetrievalGolden[] {
	if (!existsSync(goldenDir)) {
		throw new MulderEvalError(
			`Retrieval golden directory does not exist: ${goldenDir}`,
			EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY,
			{ context: { goldenDir } },
		);
	}

	const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json'));
	if (files.length === 0) {
		throw new MulderEvalError(
			`Retrieval golden directory contains no JSON files: ${goldenDir}`,
			EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY,
			{ context: { goldenDir } },
		);
	}

	const goldens: RetrievalGolden[] = [];
	for (const file of files) {
		const filePath = join(goldenDir, file);
		const raw = readFileSync(filePath, 'utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new MulderEvalError(`Failed to parse retrieval golden JSON: ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
				context: { filePath },
				cause,
			});
		}
		goldens.push(validateRetrievalGolden(parsed, filePath));
	}

	goldens.sort((a, b) => a.queryId.localeCompare(b.queryId));
	return goldens;
}

// ────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────

/**
 * Callback signature: given a golden query, return the actual retrieval hits
 * the system produced. The runner never builds this itself — callers inject
 * it so the runner stays decoupled from the retrieval package and database.
 *
 * Note the async signature — real retrieval calls hit the DB and an LLM
 * reranker, both of which are async.
 */
export type RetrievalQueryRunner = (golden: RetrievalGolden) => Promise<ActualRetrievalHit[]>;

/** Options for {@link runRetrievalEval}. */
export interface RetrievalRunOptions {
	/** k values to report Precision@k / Recall@k / F1@k for. Default: `[5, 10]`. */
	kValues?: number[];
}

/**
 * Run retrieval eval: iterate over golden queries, call the runner for each,
 * compute metrics, aggregate.
 *
 * @param goldenDir - path to `eval/golden/retrieval/`
 * @param runner    - async callback that executes a query and returns hits
 * @param options   - optional tuning (k values)
 */
export async function runRetrievalEval(
	goldenDir: string,
	runner: RetrievalQueryRunner,
	options: RetrievalRunOptions = {},
): Promise<RetrievalEvalResult> {
	const kValues = options.kValues ?? [5, 10];
	const goldens = loadRetrievalGoldenSet(goldenDir);
	const queries: RetrievalMetricResult[] = [];

	for (const golden of goldens) {
		const hits = await runner(golden);

		const atK = kValues.map((k) => computeRetrievalMetricsAtK(golden.expectedHits, hits, k));
		const mrr = computeMRR(golden.expectedHits, hits);
		const ndcg10 = computeNDCG10(golden.expectedHits, hits);
		const primaryTotal = golden.expectedHits.filter((h) => h.relevance === 'primary').length;
		const primaryRecall = countPrimaryRecall(golden.expectedHits, hits);

		const result: RetrievalMetricResult = {
			queryId: golden.queryId,
			queryText: golden.queryText,
			queryType: golden.queryType,
			difficulty: golden.difficulty,
			atK,
			mrr,
			ndcg10,
			primaryRecall,
			primaryTotal,
		};

		if (golden.queryType === 'negative') {
			result.negativeSatisfied = hits.length === 0;
		}

		queries.push(result);
	}

	return aggregate(queries);
}

/** Pick a metric at k from an array of `RetrievalMetricAtK`. Returns 0 if k is missing. */
function metricAt(atK: RetrievalMetricAtK[] | undefined, k: number, field: 'precision' | 'recall'): number {
	if (!atK) return 0;
	const entry = atK.find((m) => m.k === k);
	return entry ? entry[field] : 0;
}

function aggregate(queries: RetrievalMetricResult[]): RetrievalEvalResult {
	const nonNegative = queries.filter((q) => q.queryType !== 'negative');
	const negatives = queries.filter((q) => q.queryType === 'negative');

	const avg = (nums: number[]): number => (nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length);

	const averages = {
		precisionAt5: avg(nonNegative.map((q) => metricAt(q.atK, 5, 'precision'))),
		precisionAt10: avg(nonNegative.map((q) => metricAt(q.atK, 10, 'precision'))),
		recallAt5: avg(nonNegative.map((q) => metricAt(q.atK, 5, 'recall'))),
		recallAt10: avg(nonNegative.map((q) => metricAt(q.atK, 10, 'recall'))),
		mrr: avg(nonNegative.map((q) => q.mrr)),
		ndcg10: avg(nonNegative.map((q) => q.ndcg10)),
	};

	const negativeSatisfiedRatio =
		negatives.length === 0 ? 1 : negatives.filter((q) => q.negativeSatisfied).length / negatives.length;

	// Per query type
	const byType: Record<string, { avgMrr: number; avgPrecisionAt5: number; count: number }> = {};
	for (const q of queries) {
		const bucket = byType[q.queryType] ?? { avgMrr: 0, avgPrecisionAt5: 0, count: 0 };
		bucket.avgMrr += q.mrr;
		bucket.avgPrecisionAt5 += metricAt(q.atK, 5, 'precision');
		bucket.count += 1;
		byType[q.queryType] = bucket;
	}
	for (const key of Object.keys(byType)) {
		const b = byType[key];
		if (!b || b.count === 0) continue;
		b.avgMrr = b.avgMrr / b.count;
		b.avgPrecisionAt5 = b.avgPrecisionAt5 / b.count;
	}

	// Per difficulty
	const byDifficulty: Record<string, { avgMrr: number; count: number }> = {};
	for (const q of queries) {
		const bucket = byDifficulty[q.difficulty] ?? { avgMrr: 0, count: 0 };
		bucket.avgMrr += q.mrr;
		bucket.count += 1;
		byDifficulty[q.difficulty] = bucket;
	}
	for (const key of Object.keys(byDifficulty)) {
		const b = byDifficulty[key];
		if (!b || b.count === 0) continue;
		b.avgMrr = b.avgMrr / b.count;
	}

	return {
		timestamp: new Date().toISOString(),
		queries,
		summary: {
			totalQueries: queries.length,
			averages,
			negativeSatisfiedRatio,
			byType,
			byDifficulty,
		},
	};
}
