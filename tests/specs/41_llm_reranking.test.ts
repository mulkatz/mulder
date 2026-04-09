import { resolve } from 'node:path';
import {
	type LlmService,
	loadConfig,
	type MulderConfig,
	RETRIEVAL_ERROR_CODES,
	RetrievalError,
	type StructuredGenerateOptions,
} from '@mulder/core';
import * as retrievalPackage from '@mulder/retrieval';
import { type FusedResult, type RerankedResult, rerank, type StrategyContribution } from '@mulder/retrieval';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Black-box QA tests for Spec 41: LLM Re-ranking — Gemini Flash (M4-E5).
 *
 * `rerank()` is a library-only function that takes fused RRF results and asks
 * an `LlmService` to re-score them. Tests interact with the package through
 * its public entrypoint and use a local `LlmService` test double to control
 * the `generateStructured` return value + capture arguments.
 *
 * Each `it()` maps to one QA condition (QA-01..QA-15) from the spec's QA
 * Contract.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

type ConfigOverrides = {
	rerankEnabled?: boolean;
	rerankCandidates?: number;
	topK?: number;
};

function makeConfig(overrides: ConfigOverrides = {}): MulderConfig {
	const base = loadConfig(EXAMPLE_CONFIG);
	const cloned = JSON.parse(JSON.stringify(base)) as MulderConfig;

	if (overrides.rerankEnabled !== undefined) {
		cloned.retrieval.rerank.enabled = overrides.rerankEnabled;
	}
	if (overrides.rerankCandidates !== undefined) {
		cloned.retrieval.rerank.candidates = overrides.rerankCandidates;
	}
	if (overrides.topK !== undefined) {
		cloned.retrieval.top_k = overrides.topK;
	}

	return cloned;
}

// ---------------------------------------------------------------------------
// LlmService test double
// ---------------------------------------------------------------------------

type StubResponse = { kind: 'value'; value: unknown } | { kind: 'throw'; error: Error };

class StubLlmService implements LlmService {
	public calls: StructuredGenerateOptions[] = [];
	private response: StubResponse = { kind: 'value', value: { rankings: [] } };

	setResponse(value: unknown): void {
		this.response = { kind: 'value', value };
	}

	setThrow(err: Error): void {
		this.response = { kind: 'throw', error: err };
	}

	async generateStructured<T = unknown>(options: StructuredGenerateOptions): Promise<T> {
		this.calls.push(options);
		if (this.response.kind === 'throw') {
			throw this.response.error;
		}
		return this.response.value as T;
	}

	async generateText(): Promise<string> {
		throw new Error('generateText not implemented in stub');
	}

	async groundedGenerate(): Promise<{ text: string; groundingMetadata: Record<string, unknown> }> {
		throw new Error('groundedGenerate not implemented in stub');
	}

	async countTokens(text: string): Promise<number> {
		// Stub returns the same conservative chars/2 estimate as DevLlmService
		// so reranker tests don't depend on a real tokenizer.
		return Math.ceil(text.length / 2);
	}

	get callCount(): number {
		return this.calls.length;
	}
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeContribution(
	strategy: StrategyContribution['strategy'],
	rank: number,
	score: number,
): StrategyContribution {
	return { strategy, rank, score };
}

function makeFused(chunkId: string, rank: number, score: number, contributions?: StrategyContribution[]): FusedResult {
	return {
		chunkId,
		storyId: `story-${chunkId}`,
		content: `Passage content for ${chunkId}`,
		score,
		rank,
		contributions: contributions ?? [makeContribution('vector', rank, score)],
	};
}

function makeFusedList(count: number): FusedResult[] {
	const out: FusedResult[] = [];
	for (let i = 1; i <= count; i++) {
		const id = `chunk-${i.toString().padStart(2, '0')}`;
		out.push(makeFused(id, i, 1 / (60 + i)));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let baseConfig: MulderConfig;

beforeAll(() => {
	baseConfig = makeConfig();
});

// ---------------------------------------------------------------------------
// QA conditions
// ---------------------------------------------------------------------------

describe('Spec 41: LLM Re-ranking — Gemini Flash', () => {
	// QA-01: Feature flag disabled is passthrough
	it('QA-01: feature flag disabled is passthrough (no LLM call, RRF scores reused)', async () => {
		const config = makeConfig({ rerankEnabled: false });
		const fused = makeFusedList(15);
		const llm = new StubLlmService();

		const result = await rerank(llm, 'any query', fused, config, { limit: 10 });

		expect(llm.callCount).toBe(0);
		expect(result).toHaveLength(10);
		for (let i = 0; i < result.length; i++) {
			const ri = result[i] as RerankedResult;
			const fi = fused[i] as FusedResult;
			expect(ri.chunkId).toBe(fi.chunkId);
			expect(ri.rerankScore).toBe(fi.score);
			expect(ri.rank).toBe(i + 1);
			expect(ri.score).toBe(fi.score);
		}
	});

	// QA-02: Empty input returns empty without LLM call
	it('QA-02: empty fusedResults returns [] without calling the LLM', async () => {
		const llm = new StubLlmService();

		const result = await rerank(llm, 'any query', [], baseConfig);

		expect(result).toEqual([]);
		expect(llm.callCount).toBe(0);
	});

	// QA-03: Empty query rejected
	it('QA-03: empty or whitespace query throws RETRIEVAL_INVALID_INPUT without calling the LLM', async () => {
		const llm = new StubLlmService();
		const fused = makeFusedList(3);

		// Empty
		await expect(rerank(llm, '', fused, baseConfig)).rejects.toBeInstanceOf(RetrievalError);
		try {
			await rerank(llm, '', fused, baseConfig);
		} catch (err) {
			expect((err as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT);
		}

		// Whitespace
		await expect(rerank(llm, '   \t\n', fused, baseConfig)).rejects.toBeInstanceOf(RetrievalError);
		try {
			await rerank(llm, '   \t\n', fused, baseConfig);
		} catch (err) {
			expect((err as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT);
		}

		expect(llm.callCount).toBe(0);
	});

	// QA-04: Re-ranking reorders by Gemini scores
	it('QA-04: re-ranking reorders results according to LLM scores', async () => {
		const fused: FusedResult[] = [makeFused('A', 1, 0.9), makeFused('B', 2, 0.8), makeFused('C', 3, 0.7)];
		const llm = new StubLlmService();
		llm.setResponse({
			rankings: [
				{ passage_id: 'C', relevance_score: 0.9 },
				{ passage_id: 'A', relevance_score: 0.5 },
				{ passage_id: 'B', relevance_score: 0.1 },
			],
		});

		const result = await rerank(llm, 'query', fused, baseConfig, { limit: 3 });

		expect(result.map((r) => r.chunkId)).toEqual(['C', 'A', 'B']);

		const [first, second, third] = result;
		expect(first?.rerankScore).toBe(0.9);
		expect(second?.rerankScore).toBe(0.5);
		expect(third?.rerankScore).toBe(0.1);

		expect(first?.rank).toBe(1);
		expect(second?.rank).toBe(2);
		expect(third?.rank).toBe(3);

		// Original RRF scores preserved
		expect(first?.score).toBe(0.7); // C
		expect(second?.score).toBe(0.9); // A
		expect(third?.score).toBe(0.8); // B
	});

	// QA-05: Candidates limit truncates input to LLM
	it('QA-05: candidates limit truncates input sent to LLM', async () => {
		const config = makeConfig({ rerankCandidates: 10 });
		const fused = makeFusedList(25);
		const llm = new StubLlmService();
		llm.setResponse({ rankings: [] }); // passthrough fallback

		await rerank(llm, 'query', fused, config);

		expect(llm.callCount).toBe(1);
		const call = llm.calls[0];
		expect(call).toBeDefined();
		const prompt = call?.prompt ?? '';

		// Top 10 chunk IDs must be present
		for (let i = 1; i <= 10; i++) {
			const id = `chunk-${i.toString().padStart(2, '0')}`;
			expect(prompt).toContain(id);
		}

		// chunks 11..25 must NOT be mentioned
		for (let i = 11; i <= 25; i++) {
			const id = `chunk-${i.toString().padStart(2, '0')}`;
			expect(prompt).not.toContain(id);
		}
	});

	// QA-06: Output limit enforcement
	it('QA-06: output limit returns exactly top-N by rerankScore', async () => {
		const config = makeConfig({ rerankCandidates: 20 });
		const fused = makeFusedList(20);

		// LLM scores: chunk-01 → 0.05, chunk-02 → 0.10, ..., chunk-20 → 1.00
		// So the highest scores go to chunks 16-20.
		const rankings = fused.map((f, i) => ({
			passage_id: f.chunkId,
			relevance_score: (i + 1) * 0.05,
		}));
		const llm = new StubLlmService();
		llm.setResponse({ rankings });

		const result = await rerank(llm, 'query', fused, config, { limit: 5 });

		expect(result).toHaveLength(5);
		// Top 5 should be chunk-20, chunk-19, chunk-18, chunk-17, chunk-16
		expect(result.map((r) => r.chunkId)).toEqual(['chunk-20', 'chunk-19', 'chunk-18', 'chunk-17', 'chunk-16']);
	});

	// QA-07: Unknown passage_id in response is ignored
	it('QA-07: unknown passage_id in response is discarded, missing passages get fallback sub-floor score', async () => {
		const fused: FusedResult[] = [makeFused('A', 1, 0.9), makeFused('B', 2, 0.8), makeFused('C', 3, 0.7)];
		const llm = new StubLlmService();
		llm.setResponse({
			rankings: [
				{ passage_id: 'ZZZ', relevance_score: 0.9 },
				{ passage_id: 'A', relevance_score: 0.6 },
			],
		});

		const result = await rerank(llm, 'query', fused, baseConfig);

		// Function must not throw — ZZZ is ignored.
		expect(result).toHaveLength(3);

		// A is scored at 0.6
		const a = result.find((r) => r.chunkId === 'A');
		expect(a).toBeDefined();
		expect(a?.rerankScore).toBe(0.6);

		// B and C are below 0.6 (strict inequality)
		const b = result.find((r) => r.chunkId === 'B');
		const c = result.find((r) => r.chunkId === 'C');
		expect(b).toBeDefined();
		expect(c).toBeDefined();
		expect(b?.rerankScore).toBeLessThan(0.6);
		expect(c?.rerankScore).toBeLessThan(0.6);

		// ZZZ must not appear in the result
		expect(result.find((r) => r.chunkId === 'ZZZ')).toBeUndefined();
	});

	// QA-08: LLM failure wraps in RetrievalError
	it('QA-08: LLM call failure wraps in RetrievalError with RETRIEVAL_RERANK_FAILED (cause preserved)', async () => {
		const fused = makeFusedList(3);
		const llm = new StubLlmService();
		const underlying = new Error('vertex ai 503');
		llm.setThrow(underlying);

		let caught: unknown;
		try {
			await rerank(llm, 'query', fused, baseConfig);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(RetrievalError);
		const re = caught as RetrievalError;
		expect(re.code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_FAILED);
		expect((re as unknown as { cause?: unknown }).cause).toBe(underlying);
	});

	// QA-09: Malformed LLM response rejected
	it('QA-09: missing rankings key throws RETRIEVAL_RERANK_INVALID_RESPONSE', async () => {
		const fused = makeFusedList(3);
		const llm = new StubLlmService();
		llm.setResponse({ not_rankings: [] });

		let caught: unknown;
		try {
			await rerank(llm, 'query', fused, baseConfig);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(RetrievalError);
		expect((caught as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_INVALID_RESPONSE);
	});

	// QA-10: Relevance score out of range rejected
	it('QA-10: relevance_score out of [0,1] range throws RETRIEVAL_RERANK_INVALID_RESPONSE', async () => {
		const fused = makeFusedList(3);
		const llm = new StubLlmService();
		llm.setResponse({
			rankings: [{ passage_id: 'chunk-01', relevance_score: 1.5 }],
		});

		let caught: unknown;
		try {
			await rerank(llm, 'query', fused, baseConfig);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(RetrievalError);
		expect((caught as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_INVALID_RESPONSE);
	});

	// QA-11: FusedResult provenance is preserved
	it('QA-11: contributions provenance is deeply preserved through re-ranking', async () => {
		const contributions: StrategyContribution[] = [
			makeContribution('vector', 1, 0.91),
			makeContribution('fulltext', 2, 4.7),
		];
		const fused: FusedResult[] = [
			{
				chunkId: 'A',
				storyId: 'story-A',
				content: 'content A',
				score: 0.0234,
				rank: 1,
				contributions,
			},
			makeFused('B', 2, 0.018),
		];

		const llm = new StubLlmService();
		llm.setResponse({
			rankings: [
				{ passage_id: 'A', relevance_score: 0.8 },
				{ passage_id: 'B', relevance_score: 0.4 },
			],
		});

		const result = await rerank(llm, 'query', fused, baseConfig);

		const a = result.find((r) => r.chunkId === 'A');
		expect(a).toBeDefined();
		expect(a?.contributions).toEqual(contributions);
	});

	// QA-12: Rank is 1-based and contiguous
	it('QA-12: ranks are 1-based and contiguous with no gaps or duplicates', async () => {
		const fused = makeFusedList(10);
		const llm = new StubLlmService();
		// Assign distinct scores so ordering is stable and contiguous.
		const rankings = fused.map((f, i) => ({
			passage_id: f.chunkId,
			relevance_score: 0.99 - i * 0.05,
		}));
		llm.setResponse({ rankings });

		const result = await rerank(llm, 'query', fused, baseConfig, { limit: 10 });

		expect(result).toHaveLength(10);
		const ranks = result.map((r) => r.rank);
		for (let i = 0; i < ranks.length; i++) {
			expect(ranks[i]).toBe(i + 1);
		}
		// No duplicates
		expect(new Set(ranks).size).toBe(ranks.length);
	});

	// QA-13: Prompt contains the query text verbatim
	it('QA-13: prompt sent to the LLM contains the query substring verbatim', async () => {
		const fused = makeFusedList(3);
		const llm = new StubLlmService();
		llm.setResponse({ rankings: [] });

		const query = 'who authored the report';
		await rerank(llm, query, fused, baseConfig);

		expect(llm.callCount).toBe(1);
		const prompt = llm.calls[0]?.prompt ?? '';
		expect(prompt).toContain(query);
	});

	// QA-14: Rerank error codes are registered
	it('QA-14: RETRIEVAL_ERROR_CODES contains the rerank error codes', () => {
		expect(RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_FAILED).toBe('RETRIEVAL_RERANK_FAILED');
		expect(RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_INVALID_RESPONSE).toBe('RETRIEVAL_RERANK_INVALID_RESPONSE');
	});

	// QA-15: Barrel re-exports rerank and its types
	it('QA-15: @mulder/retrieval barrel re-exports rerank (and RerankedResult/RerankOptions at type level)', () => {
		// Runtime: `rerank` is a named export.
		expect(typeof retrievalPackage.rerank).toBe('function');
		expect(retrievalPackage.rerank).toBe(rerank);

		// Type-level: the import above of `RerankedResult` and `RerankOptions`
		// from '@mulder/retrieval' compiles successfully, which is proof of
		// the type re-export at build time. Here we exercise the type in a
		// value context via a local annotation.
		const sample: RerankedResult = {
			chunkId: 'x',
			storyId: 'y',
			content: 'z',
			score: 0.1,
			rerankScore: 0.2,
			rank: 1,
			contributions: [],
		};
		expect(sample.rank).toBe(1);
	});
});
