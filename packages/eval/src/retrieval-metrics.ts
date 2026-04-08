/**
 * Retrieval quality metrics: Precision@k, Recall@k, MRR, nDCG@10.
 *
 * This module is pure — it takes golden annotations + actual retrieval hits
 * and returns metric numbers. It does not touch the filesystem, the database,
 * or the retrieval package. All I/O lives in {@link retrieval-runner.ts}.
 *
 * Matching strategy: an actual hit "matches" an expected hit when the expected
 * hit's `contentContains` substring appears in the actual hit's content
 * (case-insensitive). This is deliberately loose — generated chunk IDs change
 * between runs, so content-based matching is the only robust option for a
 * fixture-independent golden set.
 *
 * @see docs/functional-spec.md §5 (hybrid retrieval)
 * @see docs/functional-spec.md §15 (quality evaluation)
 */

import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import type { ActualRetrievalHit, ExpectedRetrievalHit, RetrievalMetricAtK } from './types.js';

// ────────────────────────────────────────────────────────────
// Matching
// ────────────────────────────────────────────────────────────

/**
 * Check whether an actual retrieval hit matches an expected hit via
 * case-insensitive substring match on content.
 */
export function hitMatches(actual: ActualRetrievalHit, expected: ExpectedRetrievalHit): boolean {
	const haystack = actual.content.toLowerCase();
	const needle = expected.contentContains.toLowerCase();
	return haystack.includes(needle);
}

/**
 * For each expected hit, find the rank of the first actual hit that matches
 * it. Returns `undefined` for expected hits that never appeared. Ranks are
 * 1-based to match the reranker's output contract.
 */
export function findExpectedRanks(
	expected: ExpectedRetrievalHit[],
	actual: ActualRetrievalHit[],
): Array<{ expected: ExpectedRetrievalHit; rank: number | undefined }> {
	return expected.map((exp) => {
		const idx = actual.findIndex((act) => hitMatches(act, exp));
		return {
			expected: exp,
			rank: idx === -1 ? undefined : idx + 1,
		};
	});
}

// ────────────────────────────────────────────────────────────
// Precision / Recall / F1 at k
// ────────────────────────────────────────────────────────────

/**
 * Compute Precision@k, Recall@k, F1@k for a single query. Only `primary`
 * expected hits count toward Recall — `secondary` and `tangential` hits boost
 * Precision when present but are not penalized when absent.
 *
 * - Precision@k = (# of actual top-k hits that match any expected hit) / k
 * - Recall@k    = (# of primary expected hits that appear in actual top-k) / (# primary expected)
 * - F1@k        = harmonic mean
 *
 * Negative queries (no expected hits at all) return precision = recall = 1
 * when `actual` is empty, and precision = 0 when `actual` is non-empty. This
 * keeps the metric monotonic: a negative query that correctly returns nothing
 * should never drag the average down.
 */
export function computeRetrievalMetricsAtK(
	expected: ExpectedRetrievalHit[],
	actual: ActualRetrievalHit[],
	k: number,
): RetrievalMetricAtK {
	if (k <= 0 || !Number.isInteger(k)) {
		throw new MulderEvalError(
			`computeRetrievalMetricsAtK: k must be a positive integer, got ${k}`,
			EVAL_ERROR_CODES.INVALID_ARGUMENT,
			{ context: { k } },
		);
	}

	// Negative query — expected to return nothing.
	if (expected.length === 0) {
		const isEmpty = actual.length === 0;
		return {
			k,
			precision: isEmpty ? 1 : 0,
			recall: isEmpty ? 1 : 0,
			f1: isEmpty ? 1 : 0,
		};
	}

	const topK = actual.slice(0, k);
	const primaryExpected = expected.filter((e) => e.relevance === 'primary');

	// Precision: how many of the top-k hits match any expected entry (of any relevance).
	let precisionHits = 0;
	for (const a of topK) {
		if (expected.some((e) => hitMatches(a, e))) {
			precisionHits += 1;
		}
	}
	const precision = topK.length === 0 ? 0 : precisionHits / topK.length;

	// Recall: how many primary expected hits appear in top-k.
	let recallHits = 0;
	for (const e of primaryExpected) {
		if (topK.some((a) => hitMatches(a, e))) {
			recallHits += 1;
		}
	}
	const recall = primaryExpected.length === 0 ? 1 : recallHits / primaryExpected.length;

	const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

	return { k, precision, recall, f1 };
}

// ────────────────────────────────────────────────────────────
// Mean Reciprocal Rank
// ────────────────────────────────────────────────────────────

/**
 * MRR: 1 / rank of the first primary expected hit in the actual list.
 * Returns 0 if no primary expected hit appears anywhere in `actual`.
 *
 * Negative queries (no primary hits) return 1 when `actual` is empty (the
 * query was satisfied) and 0 otherwise.
 */
export function computeMRR(expected: ExpectedRetrievalHit[], actual: ActualRetrievalHit[]): number {
	const primaryExpected = expected.filter((e) => e.relevance === 'primary');

	if (primaryExpected.length === 0) {
		return actual.length === 0 ? 1 : 0;
	}

	for (let i = 0; i < actual.length; i++) {
		const hit = actual[i];
		if (!hit) continue;
		if (primaryExpected.some((e) => hitMatches(hit, e))) {
			return 1 / (i + 1);
		}
	}
	return 0;
}

// ────────────────────────────────────────────────────────────
// nDCG @10
// ────────────────────────────────────────────────────────────

/**
 * Relevance gain per expected relevance label.
 *
 * - `primary`     → 3
 * - `secondary`   → 2
 * - `tangential`  → 1
 * - (no match)    → 0
 */
function gainForExpected(expected: ExpectedRetrievalHit | undefined): number {
	if (!expected) return 0;
	switch (expected.relevance) {
		case 'primary':
			return 3;
		case 'secondary':
			return 2;
		case 'tangential':
			return 1;
		default:
			return 0;
	}
}

/**
 * DCG@k using the standard (2^rel - 1) / log2(rank + 1) formulation.
 *
 * This is the "industry" variant of DCG, which emphasizes highly-relevant
 * documents more than the "linear" variant. Picking this matches Google, MS,
 * and most academic benchmarks — and because our relevance levels top out at
 * 3, the numerator is bounded.
 */
function dcgAtK(expected: ExpectedRetrievalHit[], actual: ActualRetrievalHit[], k: number): number {
	let dcg = 0;
	for (let i = 0; i < Math.min(k, actual.length); i++) {
		const hit = actual[i];
		if (!hit) continue;
		const matched = expected.find((e) => hitMatches(hit, e));
		const gain = gainForExpected(matched);
		if (gain > 0) {
			dcg += (2 ** gain - 1) / Math.log2(i + 2);
		}
	}
	return dcg;
}

/**
 * Ideal DCG@k: sort expected entries by relevance descending, then compute
 * DCG as if that ideal ordering were retrieved.
 */
function idealDcgAtK(expected: ExpectedRetrievalHit[], k: number): number {
	const sorted = [...expected].sort((a, b) => gainForExpected(b) - gainForExpected(a));
	let idcg = 0;
	for (let i = 0; i < Math.min(k, sorted.length); i++) {
		const entry = sorted[i];
		const gain = gainForExpected(entry);
		if (gain > 0) {
			idcg += (2 ** gain - 1) / Math.log2(i + 2);
		}
	}
	return idcg;
}

/**
 * Normalized DCG@10. Returns 0 when the ideal DCG is 0 (meaning there are no
 * `primary`/`secondary`/`tangential` hits expected — typically a negative
 * query). Returns a value in [0, 1] otherwise.
 */
export function computeNDCG10(expected: ExpectedRetrievalHit[], actual: ActualRetrievalHit[]): number {
	const idcg = idealDcgAtK(expected, 10);
	if (idcg === 0) {
		return 0;
	}
	const dcg = dcgAtK(expected, actual, 10);
	return dcg / idcg;
}

// ────────────────────────────────────────────────────────────
// Helpers for the runner
// ────────────────────────────────────────────────────────────

/**
 * Count how many `primary` expected hits appear anywhere in the actual result
 * list (no rank cutoff). Used for per-query "primary recall" reporting.
 */
export function countPrimaryRecall(expected: ExpectedRetrievalHit[], actual: ActualRetrievalHit[]): number {
	const primaryExpected = expected.filter((e) => e.relevance === 'primary');
	let count = 0;
	for (const e of primaryExpected) {
		if (actual.some((a) => hitMatches(a, e))) {
			count += 1;
		}
	}
	return count;
}
