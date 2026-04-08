/**
 * Black-box unit tests for Spec 43 (QA-Gate Phase 3):
 * retrieval metrics — Precision@k, Recall@k, F1@k, MRR, nDCG@10.
 *
 * System boundary: the public surface of `@mulder/eval`
 * (`computeRetrievalMetricsAtK`, `computeMRR`, `computeNDCG10`, etc.).
 * No internal source files are imported.
 *
 * These tests pin down the mathematical behavior of the pure metric
 * functions in isolation from any database, fixture, or retrieval layer.
 */

import { resolve } from 'node:path';
import {
	type ActualRetrievalHit,
	computeMRR,
	computeNDCG10,
	computeRetrievalMetricsAtK,
	countPrimaryRecall,
	EVAL_ERROR_CODES,
	type ExpectedRetrievalHit,
	hitMatches,
	loadRetrievalGoldenSet,
	MulderEvalError,
} from '@mulder/eval';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHit(content: string, rank: number, score = 0.9): ActualRetrievalHit {
	return {
		chunkId: `chunk-${rank}`,
		storyId: 'story-1',
		content,
		rank,
		score,
	};
}

const primary = (text: string): ExpectedRetrievalHit => ({
	contentContains: text,
	relevance: 'primary',
});

const secondary = (text: string): ExpectedRetrievalHit => ({
	contentContains: text,
	relevance: 'secondary',
});

const tangential = (text: string): ExpectedRetrievalHit => ({
	contentContains: text,
	relevance: 'tangential',
});

// ---------------------------------------------------------------------------
// hitMatches
// ---------------------------------------------------------------------------

describe('Spec 43 — retrieval metrics — hitMatches', () => {
	it('QA-01: matches case-insensitively on substring', () => {
		const actual = makeHit('The Phoenix Lights appeared on March 13, 1997', 1);
		expect(hitMatches(actual, primary('phoenix lights'))).toBe(true);
		expect(hitMatches(actual, primary('PHOENIX LIGHTS'))).toBe(true);
		expect(hitMatches(actual, primary('March 13, 1997'))).toBe(true);
	});

	it('QA-02: returns false when substring is absent', () => {
		const actual = makeHit('Unrelated text about weather patterns', 1);
		expect(hitMatches(actual, primary('Phoenix'))).toBe(false);
	});

	it('QA-03: matches even when substring spans word boundaries', () => {
		const actual = makeHit('Captain Robert Salas was the on-duty missile commander', 1);
		expect(hitMatches(actual, primary('Robert Salas'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// computeRetrievalMetricsAtK
// ---------------------------------------------------------------------------

describe('Spec 43 — retrieval metrics — computeRetrievalMetricsAtK', () => {
	it('QA-04: perfect top-k match → precision=1, recall=1, f1=1', () => {
		const expected = [primary('alpha'), primary('beta'), primary('gamma')];
		const actual = [makeHit('alpha', 1), makeHit('beta', 2), makeHit('gamma', 3)];
		const m = computeRetrievalMetricsAtK(expected, actual, 5);
		expect(m.precision).toBeCloseTo(3 / 3);
		expect(m.recall).toBeCloseTo(1);
		expect(m.f1).toBeCloseTo(1);
	});

	it('QA-05: no matches → precision=0, recall=0, f1=0', () => {
		const expected = [primary('alpha')];
		const actual = [makeHit('zzzz', 1), makeHit('yyyy', 2)];
		const m = computeRetrievalMetricsAtK(expected, actual, 5);
		expect(m.precision).toBe(0);
		expect(m.recall).toBe(0);
		expect(m.f1).toBe(0);
	});

	it('QA-06: partial recall — 1 of 2 primary hits found in top-5', () => {
		const expected = [primary('alpha'), primary('beta')];
		const actual = [makeHit('alpha', 1), makeHit('garbage', 2)];
		const m = computeRetrievalMetricsAtK(expected, actual, 5);
		expect(m.precision).toBe(1 / 2);
		expect(m.recall).toBe(1 / 2);
		expect(m.f1).toBe(0.5);
	});

	it('QA-07: Recall only counts primary hits, not secondary/tangential', () => {
		const expected = [primary('alpha'), secondary('beta'), tangential('gamma')];
		// Only 'alpha' (the sole primary) is in top-k — recall should be 1.
		const actual = [makeHit('alpha', 1)];
		const m = computeRetrievalMetricsAtK(expected, actual, 5);
		expect(m.recall).toBe(1);
		expect(m.precision).toBe(1); // 1 of 1 top-k matches something
	});

	it('QA-08: Precision counts any relevance level', () => {
		const expected = [primary('alpha'), secondary('beta')];
		const actual = [makeHit('alpha', 1), makeHit('beta', 2)];
		const m = computeRetrievalMetricsAtK(expected, actual, 5);
		expect(m.precision).toBe(1); // both top-k hits match something
	});

	it('QA-09: k truncates actual results', () => {
		const expected = [primary('alpha'), primary('beta'), primary('gamma')];
		const actual = [makeHit('alpha', 1), makeHit('beta', 2), makeHit('gamma', 3)];
		const m = computeRetrievalMetricsAtK(expected, actual, 2);
		expect(m.precision).toBe(1); // top-2 both match
		expect(m.recall).toBe(2 / 3); // 2 of 3 primary hits in top-2
	});

	it('QA-10: negative query (no expected) + empty actual → all 1s', () => {
		const m = computeRetrievalMetricsAtK([], [], 5);
		expect(m.precision).toBe(1);
		expect(m.recall).toBe(1);
		expect(m.f1).toBe(1);
	});

	it('QA-11: negative query + non-empty actual → all 0s', () => {
		const m = computeRetrievalMetricsAtK([], [makeHit('anything', 1)], 5);
		expect(m.precision).toBe(0);
		expect(m.recall).toBe(0);
		expect(m.f1).toBe(0);
	});

	it('QA-12: invalid k is rejected with typed MulderEvalError(EVAL_INVALID_ARGUMENT)', () => {
		for (const invalidK of [0, -1, 1.5]) {
			try {
				computeRetrievalMetricsAtK([primary('x')], [], invalidK);
				throw new Error(`expected computeRetrievalMetricsAtK to throw for k=${invalidK}`);
			} catch (err) {
				expect(err).toBeInstanceOf(MulderEvalError);
				expect((err as MulderEvalError).code).toBe(EVAL_ERROR_CODES.INVALID_ARGUMENT);
				expect((err as MulderEvalError).message).toMatch(/positive integer/);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// computeMRR
// ---------------------------------------------------------------------------

describe('Spec 43 — retrieval metrics — computeMRR', () => {
	it('QA-13: first primary hit at rank 1 → MRR = 1.0', () => {
		const expected = [primary('alpha')];
		const actual = [makeHit('alpha', 1), makeHit('beta', 2)];
		expect(computeMRR(expected, actual)).toBe(1);
	});

	it('QA-14: first primary hit at rank 3 → MRR = 1/3', () => {
		const expected = [primary('alpha')];
		const actual = [makeHit('zz', 1), makeHit('yy', 2), makeHit('alpha', 3)];
		expect(computeMRR(expected, actual)).toBeCloseTo(1 / 3);
	});

	it('QA-15: no primary hit in actual → MRR = 0', () => {
		const expected = [primary('alpha')];
		const actual = [makeHit('nothing', 1), makeHit('nada', 2)];
		expect(computeMRR(expected, actual)).toBe(0);
	});

	it('QA-16: secondary/tangential hits do not contribute to MRR', () => {
		const expected = [secondary('alpha'), tangential('beta')];
		const actual = [makeHit('alpha', 1), makeHit('beta', 2)];
		expect(computeMRR(expected, actual)).toBe(0);
	});

	it('QA-17: negative query + empty actual → MRR = 1 (query satisfied)', () => {
		expect(computeMRR([], [])).toBe(1);
	});

	it('QA-18: negative query + non-empty actual → MRR = 0', () => {
		expect(computeMRR([], [makeHit('x', 1)])).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// computeNDCG10
// ---------------------------------------------------------------------------

describe('Spec 43 — retrieval metrics — computeNDCG10', () => {
	it('QA-19: ideal ordering (highest relevance first) → nDCG = 1.0', () => {
		const expected = [primary('alpha'), secondary('beta'), tangential('gamma')];
		const actual = [makeHit('alpha', 1), makeHit('beta', 2), makeHit('gamma', 3)];
		expect(computeNDCG10(expected, actual)).toBeCloseTo(1);
	});

	it('QA-20: reversed ordering → nDCG < 1', () => {
		const expected = [primary('alpha'), secondary('beta'), tangential('gamma')];
		const actual = [makeHit('gamma', 1), makeHit('beta', 2), makeHit('alpha', 3)];
		const n = computeNDCG10(expected, actual);
		expect(n).toBeLessThan(1);
		expect(n).toBeGreaterThan(0);
	});

	it('QA-21: empty actual → nDCG = 0', () => {
		expect(computeNDCG10([primary('alpha')], [])).toBe(0);
	});

	it('QA-22: negative query (no expected hits) → nDCG = 0 (ideal is 0)', () => {
		expect(computeNDCG10([], [])).toBe(0);
		expect(computeNDCG10([], [makeHit('x', 1)])).toBe(0);
	});

	it('QA-23: nDCG is sensitive to rank — same hits in different positions produce different scores', () => {
		const expected = [primary('alpha'), primary('beta')];
		const highRank = [makeHit('alpha', 1), makeHit('beta', 2)];
		const lowRank = [makeHit('zzz', 1), makeHit('yyy', 2), makeHit('alpha', 3), makeHit('beta', 4)];
		expect(computeNDCG10(expected, highRank)).toBeGreaterThan(computeNDCG10(expected, lowRank));
	});
});

// ---------------------------------------------------------------------------
// countPrimaryRecall
// ---------------------------------------------------------------------------

describe('Spec 43 — retrieval metrics — countPrimaryRecall', () => {
	it('QA-24: counts primary hits anywhere in actual (no rank cutoff)', () => {
		const expected = [primary('alpha'), primary('beta'), secondary('gamma')];
		const actual = [makeHit('zz', 1), makeHit('alpha', 2), makeHit('yy', 3), makeHit('beta', 4), makeHit('gamma', 5)];
		expect(countPrimaryRecall(expected, actual)).toBe(2);
	});

	it('QA-25: returns 0 when no primary hits are expected', () => {
		expect(countPrimaryRecall([secondary('x'), tangential('y')], [makeHit('x', 1)])).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// loadRetrievalGoldenSet (integration with Phase 3 D5 golden files)
// ---------------------------------------------------------------------------

describe('Spec 43 — retrieval metrics — loadRetrievalGoldenSet', () => {
	it('QA-26: loads all 12 QA-gate golden retrieval queries', () => {
		const goldenDir = resolve(import.meta.dirname, '../../eval/golden/retrieval');
		const goldens = loadRetrievalGoldenSet(goldenDir);
		expect(goldens.length).toBe(12);

		// Spot check: queryIds are unique and sorted
		const ids = goldens.map((g) => g.queryId);
		expect(new Set(ids).size).toBe(12);
		expect([...ids]).toEqual([...ids].sort());
	});

	it('QA-27: all golden files validate (well-formed structure)', () => {
		const goldenDir = resolve(import.meta.dirname, '../../eval/golden/retrieval');
		const goldens = loadRetrievalGoldenSet(goldenDir);
		for (const g of goldens) {
			expect(g.queryId).toBeTruthy();
			expect(g.queryText).toBeTruthy();
			expect(['de', 'en']).toContain(g.language);
			expect(['factual', 'exploratory', 'relational', 'negative']).toContain(g.queryType);
			if (g.queryType === 'negative') {
				expect(g.expectedHits).toEqual([]);
			} else {
				expect(g.expectedHits.length).toBeGreaterThan(0);
			}
		}
	});

	it('QA-28: includes at least one negative query per language', () => {
		const goldenDir = resolve(import.meta.dirname, '../../eval/golden/retrieval');
		const goldens = loadRetrievalGoldenSet(goldenDir);
		const negatives = goldens.filter((g) => g.queryType === 'negative');
		expect(negatives.length).toBeGreaterThanOrEqual(2);
		const negativeLangs = new Set(negatives.map((n) => n.language));
		expect(negativeLangs.has('en')).toBe(true);
		expect(negativeLangs.has('de')).toBe(true);
	});
});
