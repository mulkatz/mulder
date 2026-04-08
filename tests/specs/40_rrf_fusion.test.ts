import { resolve } from 'node:path';
import { loadConfig, type MulderConfig, RETRIEVAL_ERROR_CODES, RetrievalError } from '@mulder/core';
import { type FusedResult, type RetrievalResult, type RetrievalStrategy, rrfFuse } from '@mulder/retrieval';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 40: RRF Fusion — Configurable Weights (M4-E4).
 *
 * This is a pure-function test suite. `rrfFuse` takes strategy results + config,
 * returns fused results. No database, no network, no containers needed.
 *
 * Each `it()` maps to one QA condition (QA-01..QA-12) from the spec's QA Contract.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: {
	topK?: number;
	vectorWeight?: number;
	fulltextWeight?: number;
	graphWeight?: number;
}): MulderConfig {
	const base = loadConfig(EXAMPLE_CONFIG);
	const cloned = JSON.parse(JSON.stringify(base)) as MulderConfig;

	if (overrides?.topK !== undefined) {
		cloned.retrieval.top_k = overrides.topK;
	}
	if (overrides?.vectorWeight !== undefined) {
		cloned.retrieval.strategies.vector.weight = overrides.vectorWeight;
	}
	if (overrides?.fulltextWeight !== undefined) {
		cloned.retrieval.strategies.fulltext.weight = overrides.fulltextWeight;
	}
	if (overrides?.graphWeight !== undefined) {
		cloned.retrieval.strategies.graph.weight = overrides.graphWeight;
	}

	return cloned;
}

/** Create a RetrievalResult with sensible defaults. */
function makeResult(chunkId: string, strategy: RetrievalStrategy, rank: number, score: number): RetrievalResult {
	return {
		chunkId,
		storyId: `story-${chunkId}`,
		content: `Content of ${chunkId}`,
		score,
		rank,
		strategy,
	};
}

/** Build a Map from an array of [strategy, results[]] pairs. */
function resultsMap(...entries: [RetrievalStrategy, RetrievalResult[]][]): Map<RetrievalStrategy, RetrievalResult[]> {
	return new Map(entries);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let baseConfig: MulderConfig;

beforeAll(() => {
	baseConfig = makeConfig();
});

// ---------------------------------------------------------------------------
// QA conditions
// ---------------------------------------------------------------------------

describe('Spec 40: RRF Fusion — Configurable Weights', () => {
	// QA-01: Single-strategy passthrough
	it('QA-01: single-strategy passthrough returns correct RRF scores', () => {
		const vectorResults: RetrievalResult[] = [];
		for (let i = 1; i <= 5; i++) {
			vectorResults.push(makeResult(`chunk-${i}`, 'vector', i, 1.0 - i * 0.1));
		}

		const input = resultsMap(['vector', vectorResults]);
		const fused = rrfFuse(input, baseConfig);

		// Should return 5 results
		expect(fused).toHaveLength(5);

		// Each result's score should be vector_weight / (60 + rank)
		const vectorWeight = baseConfig.retrieval.strategies.vector.weight;
		for (const result of fused) {
			const contribution = result.contributions.find((c) => c.strategy === 'vector');
			expect(contribution).toBeDefined();
			const expectedScore = vectorWeight / (60 + (contribution?.rank ?? 0));
			expect(result.score).toBeCloseTo(expectedScore, 10);
		}

		// Should be sorted descending by score
		for (let i = 1; i < fused.length; i++) {
			expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
		}
	});

	// QA-02: Multi-strategy deduplication
	it('QA-02: multi-strategy deduplication merges shared chunks and deduplicates', () => {
		const vectorResults = [
			makeResult('A', 'vector', 1, 0.9),
			makeResult('B', 'vector', 2, 0.8),
			makeResult('C', 'vector', 3, 0.7),
		];
		const fulltextResults = [
			makeResult('B', 'fulltext', 1, 5.0),
			makeResult('C', 'fulltext', 2, 4.0),
			makeResult('D', 'fulltext', 3, 3.0),
		];

		const input = resultsMap(['vector', vectorResults], ['fulltext', fulltextResults]);
		const fused = rrfFuse(input, baseConfig);

		// Should have 4 unique chunks
		expect(fused).toHaveLength(4);

		// No duplicate chunkIds
		const chunkIds = fused.map((r) => r.chunkId);
		expect(new Set(chunkIds).size).toBe(4);

		// B and C should have higher scores (double contribution) than A and D
		const scoreOf = (id: string) => {
			const found = fused.find((r) => r.chunkId === id);
			expect(found).toBeDefined();
			return found?.score ?? 0;
		};
		expect(scoreOf('B')).toBeGreaterThan(scoreOf('A'));
		expect(scoreOf('B')).toBeGreaterThan(scoreOf('D'));
		expect(scoreOf('C')).toBeGreaterThan(scoreOf('A'));
		expect(scoreOf('C')).toBeGreaterThan(scoreOf('D'));
	});

	// QA-03: Weighted scoring
	it('QA-03: weighted scoring produces correct scores for different strategy weights', () => {
		const config = makeConfig({ vectorWeight: 0.5, fulltextWeight: 0.3 });

		const vectorResults = [makeResult('A', 'vector', 1, 0.9)];
		const fulltextResults = [makeResult('B', 'fulltext', 1, 5.0)];

		const input = resultsMap(['vector', vectorResults], ['fulltext', fulltextResults]);
		const fused = rrfFuse(input, config, { k: 60 });

		const resultA = fused.find((r) => r.chunkId === 'A');
		const resultB = fused.find((r) => r.chunkId === 'B');
		expect(resultA).toBeDefined();
		expect(resultB).toBeDefined();

		const scoreA = resultA?.score ?? 0;
		const scoreB = resultB?.score ?? 0;

		// A's score = 0.5 / (60 + 1) ≈ 0.008197
		// B's score = 0.3 / (60 + 1) ≈ 0.004918
		expect(scoreA).toBeCloseTo(0.5 / 61, 10);
		expect(scoreB).toBeCloseTo(0.3 / 61, 10);
		expect(scoreA).toBeGreaterThan(scoreB);

		// A ranks higher than B
		const rankA = resultA?.rank ?? 0;
		const rankB = resultB?.rank ?? 0;
		expect(rankA).toBeLessThan(rankB);
	});

	// QA-04: Three-strategy fusion with shared chunk
	it('QA-04: three-strategy fusion sums scores for a chunk appearing in all strategies', () => {
		const config = makeConfig({
			vectorWeight: 0.5,
			fulltextWeight: 0.3,
			graphWeight: 0.2,
		});

		const vectorResults = [makeResult('X', 'vector', 1, 0.9)];
		const fulltextResults = [makeResult('X', 'fulltext', 2, 4.5)];
		const graphResults = [makeResult('X', 'graph', 3, 0.7)];

		const input = resultsMap(['vector', vectorResults], ['fulltext', fulltextResults], ['graph', graphResults]);
		const fused = rrfFuse(input, config);

		expect(fused).toHaveLength(1);

		const result = fused[0] as FusedResult;
		expect(result.chunkId).toBe('X');

		// Score = 0.5/(60+1) + 0.3/(60+2) + 0.2/(60+3)
		const expectedScore = 0.5 / 61 + 0.3 / 62 + 0.2 / 63;
		expect(result.score).toBeCloseTo(expectedScore, 10);

		// Contributions should have 3 entries
		expect(result.contributions).toHaveLength(3);

		const strategies = result.contributions.map((c) => c.strategy).sort();
		expect(strategies).toEqual(['fulltext', 'graph', 'vector']);
	});

	// QA-05: Zero-weight strategy exclusion
	it('QA-05: zero-weight strategy results are excluded from fusion', () => {
		const config = makeConfig({
			vectorWeight: 0.5,
			fulltextWeight: 0.3,
			graphWeight: 0.0,
		});

		const vectorResults = [makeResult('A', 'vector', 1, 0.9)];
		const fulltextResults = [makeResult('B', 'fulltext', 1, 5.0)];
		const graphResults = [makeResult('C', 'graph', 1, 0.8)];

		const input = resultsMap(['vector', vectorResults], ['fulltext', fulltextResults], ['graph', graphResults]);
		const fused = rrfFuse(input, config);

		// Graph results should be excluded entirely
		const chunkIds = fused.map((r) => r.chunkId);
		expect(chunkIds).not.toContain('C');

		// Only vector and fulltext contributions
		const allStrategies = fused.flatMap((r) => r.contributions.map((c) => c.strategy));
		expect(allStrategies).not.toContain('graph');

		// Should have only A and B
		expect(fused).toHaveLength(2);
	});

	// QA-06: Empty input returns empty
	it('QA-06: empty strategyResults map returns empty array without error', () => {
		const input = new Map<RetrievalStrategy, RetrievalResult[]>();
		const fused = rrfFuse(input, baseConfig);

		expect(fused).toEqual([]);
	});

	// QA-07: Limit enforcement
	it('QA-07: limit enforces maximum number of fused results', () => {
		// Create 30 unique chunks across two strategies
		const vectorResults: RetrievalResult[] = [];
		const fulltextResults: RetrievalResult[] = [];
		for (let i = 1; i <= 15; i++) {
			vectorResults.push(makeResult(`v-chunk-${i}`, 'vector', i, 1.0 - i * 0.05));
			fulltextResults.push(makeResult(`f-chunk-${i}`, 'fulltext', i, 5.0 - i * 0.3));
		}

		const input = resultsMap(['vector', vectorResults], ['fulltext', fulltextResults]);
		const fused = rrfFuse(input, baseConfig, { limit: 10 });

		expect(fused).toHaveLength(10);
	});

	// QA-08: Custom k parameter
	it('QA-08: custom k parameter is used instead of default 60', () => {
		const config = makeConfig({ vectorWeight: 0.5 });
		const vectorResults = [makeResult('A', 'vector', 1, 0.9), makeResult('B', 'vector', 2, 0.8)];

		const input = resultsMap(['vector', vectorResults]);

		// With k=1
		const fusedK1 = rrfFuse(input, config, { k: 1 });
		// With default k=60
		const fusedK60 = rrfFuse(input, config);

		// Scores with k=1 should be much higher than k=60
		// k=1: A score = 0.5/(1+1) = 0.25, B score = 0.5/(1+2) ≈ 0.1667
		// k=60: A score = 0.5/(60+1) ≈ 0.0082, B score = 0.5/(60+2) ≈ 0.0081
		const resultAK1 = fusedK1.find((r) => r.chunkId === 'A');
		const resultAK60 = fusedK60.find((r) => r.chunkId === 'A');
		expect(resultAK1).toBeDefined();
		expect(resultAK60).toBeDefined();
		const scoreAK1 = resultAK1?.score ?? 0;
		const scoreAK60 = resultAK60?.score ?? 0;

		expect(scoreAK1).toBeCloseTo(0.5 / 2, 10);
		expect(scoreAK60).toBeCloseTo(0.5 / 61, 10);
		expect(scoreAK1).toBeGreaterThan(scoreAK60);
	});

	// QA-09: Rank assignment is 1-based and contiguous
	it('QA-09: ranks are 1-based and contiguous with no gaps', () => {
		const vectorResults: RetrievalResult[] = [];
		for (let i = 1; i <= 8; i++) {
			vectorResults.push(makeResult(`chunk-${i}`, 'vector', i, 1.0 - i * 0.1));
		}

		const input = resultsMap(['vector', vectorResults]);
		const fused = rrfFuse(input, baseConfig);

		expect(fused.length).toBeGreaterThan(0);

		// Ranks should be 1, 2, 3, ..., N
		const ranks = fused.map((r) => r.rank);
		for (let i = 0; i < ranks.length; i++) {
			expect(ranks[i]).toBe(i + 1);
		}
	});

	// QA-10: Invalid weights rejected
	it('QA-10: negative weight throws RetrievalError with RETRIEVAL_FUSION_INVALID_WEIGHTS', () => {
		const vectorResults = [makeResult('A', 'vector', 1, 0.9)];
		const input = resultsMap(['vector', vectorResults]);

		expect(() => {
			rrfFuse(input, baseConfig, { weights: { vector: -0.5 } });
		}).toThrow(RetrievalError);

		try {
			rrfFuse(input, baseConfig, { weights: { vector: -0.5 } });
		} catch (err) {
			expect((err as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_FUSION_INVALID_WEIGHTS);
		}
	});

	// QA-11: Invalid k rejected
	it('QA-11: k=0 or k=-1 throws RetrievalError with RETRIEVAL_FUSION_INVALID_K', () => {
		const vectorResults = [makeResult('A', 'vector', 1, 0.9)];
		const input = resultsMap(['vector', vectorResults]);

		// k=0
		expect(() => {
			rrfFuse(input, baseConfig, { k: 0 });
		}).toThrow(RetrievalError);

		try {
			rrfFuse(input, baseConfig, { k: 0 });
		} catch (err) {
			expect((err as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_FUSION_INVALID_K);
		}

		// k=-1
		expect(() => {
			rrfFuse(input, baseConfig, { k: -1 });
		}).toThrow(RetrievalError);

		try {
			rrfFuse(input, baseConfig, { k: -1 });
		} catch (err) {
			expect((err as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_FUSION_INVALID_K);
		}
	});

	// QA-12: Contributions track provenance
	it('QA-12: contributions array tracks correct strategy, rank, and score for each contributing strategy', () => {
		const config = makeConfig({ vectorWeight: 0.5, fulltextWeight: 0.3 });

		const vectorResults = [makeResult('A', 'vector', 1, 0.95), makeResult('B', 'vector', 2, 0.85)];
		const fulltextResults = [makeResult('B', 'fulltext', 1, 5.0), makeResult('C', 'fulltext', 2, 4.0)];

		const input = resultsMap(['vector', vectorResults], ['fulltext', fulltextResults]);
		const fused = rrfFuse(input, config);

		// Find chunk B which appears in both strategies
		const chunkB = fused.find((r) => r.chunkId === 'B');
		expect(chunkB).toBeDefined();
		expect(chunkB?.contributions).toHaveLength(2);

		// Check vector contribution for B
		const vectorContrib = chunkB?.contributions.find((c) => c.strategy === 'vector');
		expect(vectorContrib).toBeDefined();
		expect(vectorContrib?.rank).toBe(2);
		expect(vectorContrib?.score).toBe(0.85);

		// Check fulltext contribution for B
		const fulltextContrib = chunkB?.contributions.find((c) => c.strategy === 'fulltext');
		expect(fulltextContrib).toBeDefined();
		expect(fulltextContrib?.rank).toBe(1);
		expect(fulltextContrib?.score).toBe(5.0);
	});
});
