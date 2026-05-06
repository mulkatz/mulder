import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	type EmbeddingResult,
	type EmbeddingService,
	type GroundedGenerateResult,
	type LlmService,
	loadConfig,
	type MulderConfig,
	RETRIEVAL_ERROR_CODES,
	RetrievalError,
	type StructuredGenerateOptions,
} from '@mulder/core';
import {
	computeQueryConfidence,
	extractQueryEntities,
	type HybridRetrievalResult,
	hybridRetrieve,
	type QueryConfidence,
} from '@mulder/retrieval';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { testStoragePath } from '../lib/storage.js';

/**
 * Black-box QA tests for Spec 42: Hybrid Retrieval Orchestrator (M4-E6).
 *
 * Each `it()` maps to one QA condition (QA-01..QA-22) or CLI condition
 * (CLI-01..CLI-09) from the spec's QA Contract.
 *
 * Interaction is through system boundaries only:
 * - `@mulder/retrieval` + `@mulder/core` public entrypoints for library tests
 * - `spawnSync` CLI subprocess + the shared env-driven SQL helper for integration tests
 *
 * Never imports from packages/src, apps/src, or any internal module.
 *
 * Requires:
 *   - PostgreSQL reachable through the standard PG env vars with migrations applied
 *   - Built CLI at apps/cli/dist/index.js
 *   - Test fixtures in fixtures/raw/
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = testStoragePath('extracted');
const SEGMENTS_DIR = testStoragePath('segments');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

// ---------------------------------------------------------------------------
// CLI + SQL helpers
// ---------------------------------------------------------------------------

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 60000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, MULDER_LOG_LEVEL: 'silent', ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Extracts the first top-level JSON object from CLI stdout. Handles the case
 * where log lines or other output precede the JSON payload — finds the first
 * `{` and matches brace depth to locate the end of the payload.
 */
function parseCliJson<T>(stdout: string): T {
	const start = stdout.indexOf('{');
	if (start === -1) {
		throw new Error(`No JSON object found in CLI output: ${stdout.slice(0, 200)}`);
	}
	let depth = 0;
	let inString = false;
	let isEscaped = false;
	for (let i = start; i < stdout.length; i++) {
		const ch = stdout[i];
		if (isEscaped) {
			isEscaped = false;
			continue;
		}
		if (ch === '\\' && inString) {
			isEscaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return JSON.parse(stdout.slice(start, i + 1)) as T;
			}
		}
	}
	throw new Error(`Unterminated JSON object in CLI output: ${stdout.slice(start, start + 200)}`);
}

function cleanTestData(): void {
	db.runSql(
		'DELETE FROM chunks; DELETE FROM story_entities; DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM stories; DELETE FROM source_steps; DELETE FROM sources;',
	);
}

function cleanStorageFixtures(): void {
	for (const dir of [SEGMENTS_DIR, EXTRACTED_DIR]) {
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (entry === '_schema.json') continue;
				rmSync(join(dir, entry), { recursive: true, force: true });
			}
		}
	}
}

/**
 * Ensure page images exist for an extracted source.
 * Creates minimal valid PNGs if the canvas module was unavailable during extraction.
 */
function ensurePageImages(sourceId: string): void {
	const pagesDir = join(EXTRACTED_DIR, sourceId, 'pages');
	if (existsSync(pagesDir)) return;
	const layoutPath = join(EXTRACTED_DIR, sourceId, 'layout.json');
	if (!existsSync(layoutPath)) return;
	const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
	mkdirSync(pagesDir, { recursive: true });
	const minimalPng = Buffer.from(
		'89504e470d0a1a0a0000000d49484452000000010000000108020000009001be' +
			'0000000c4944415478da6360f80f00000101000518d84e0000000049454e44ae426082',
		'hex',
	);
	for (let i = 1; i <= layout.pageCount; i++) {
		const padded = String(i).padStart(3, '0');
		writeFileSync(join(pagesDir, `page-${padded}.png`), minimalPng);
	}
}

function ingestPdf(pdfPath: string): string {
	const { exitCode, stdout, stderr } = runCli(['ingest', pdfPath]);
	if (exitCode !== 0) {
		throw new Error(`Ingest failed (exit ${exitCode}): ${stdout} ${stderr}`);
	}
	const filename = pdfPath.split('/').pop() ?? '';
	const sourceId = db.runSql(`SELECT id FROM sources WHERE filename = '${filename}' ORDER BY created_at DESC LIMIT 1;`);
	if (!sourceId) throw new Error(`No source record for ${filename}`);
	return sourceId;
}

function runFullPipeline(pdfPath: string): string {
	const sourceId = ingestPdf(pdfPath);

	const ex = runCli(['extract', sourceId]);
	if (ex.exitCode !== 0) throw new Error(`Extract failed: ${ex.stdout} ${ex.stderr}`);
	ensurePageImages(sourceId);

	const seg = runCli(['segment', sourceId]);
	if (seg.exitCode !== 0) throw new Error(`Segment failed: ${seg.stdout} ${seg.stderr}`);

	const enr = runCli(['enrich', '--source', sourceId], { timeout: 120000 });
	if (enr.exitCode !== 0) throw new Error(`Enrich failed: ${enr.stdout} ${enr.stderr}`);

	const storyIds = db
		.runSql(`SELECT id FROM stories WHERE source_id = '${sourceId}';`)
		.split('\n')
		.filter((s) => s.length > 0);

	for (const storyId of storyIds) {
		const emb = runCli(['embed', storyId], { timeout: 120000 });
		if (emb.exitCode !== 0) throw new Error(`Embed failed for ${storyId}: ${emb.stdout} ${emb.stderr}`);
	}

	for (const storyId of storyIds) {
		const gr = runCli(['graph', storyId], { timeout: 60000 });
		if (gr.exitCode !== 0) throw new Error(`Graph failed for ${storyId}: ${gr.stdout} ${gr.stderr}`);
	}

	return sourceId;
}

// ---------------------------------------------------------------------------
// Direct DB pool for library-level tests
// ---------------------------------------------------------------------------

function makePool(): pg.Pool {
	return new pg.Pool({
		host: db.TEST_PG_HOST,
		port: db.TEST_PG_PORT,
		user: db.TEST_PG_USER,
		password: db.TEST_PG_PASSWORD,
		database: db.TEST_PG_DATABASE,
		max: 4,
	});
}

// ---------------------------------------------------------------------------
// LlmService test double
// ---------------------------------------------------------------------------

type StubLlmResponse = { kind: 'value'; value: unknown } | { kind: 'throw'; error: Error };

class StubLlmService implements LlmService {
	public calls: StructuredGenerateOptions[] = [];
	private response: StubLlmResponse = { kind: 'value', value: { rankings: [] } };

	setResponse(value: unknown): void {
		this.response = { kind: 'value', value };
	}

	setThrow(error: Error): void {
		this.response = { kind: 'throw', error };
	}

	async generateStructured<T = unknown>(options: StructuredGenerateOptions): Promise<T> {
		this.calls.push(options);
		if (this.response.kind === 'throw') throw this.response.error;
		return this.response.value as T;
	}

	async generateText(): Promise<string> {
		throw new Error('generateText not implemented in stub');
	}

	async groundedGenerate(): Promise<GroundedGenerateResult> {
		throw new Error('groundedGenerate not implemented in stub');
	}

	async countTokens(text: string): Promise<number> {
		// Stub returns the same conservative chars/2 estimate as DevLlmService.
		return Math.ceil(text.length / 2);
	}

	get callCount(): number {
		return this.calls.length;
	}
}

// ---------------------------------------------------------------------------
// EmbeddingService test doubles
// ---------------------------------------------------------------------------

class FakeEmbeddingService implements EmbeddingService {
	async embed(texts: string[]): Promise<EmbeddingResult[]> {
		return texts.map((text) => ({ text, vector: new Array(768).fill(0.01) }));
	}
}

class ThrowingEmbeddingService implements EmbeddingService {
	async embed(_texts: string[]): Promise<EmbeddingResult[]> {
		throw new Error('embedding service is dead');
	}
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: (config: MulderConfig) => void): MulderConfig {
	const base = loadConfig(EXAMPLE_CONFIG);
	const cloned = JSON.parse(JSON.stringify(base)) as MulderConfig;
	overrides?.(cloned);
	return cloned;
}

// ---------------------------------------------------------------------------
// QA conditions (library-level)
// ---------------------------------------------------------------------------

describe('Spec 42 — Hybrid Retrieval Orchestrator', () => {
	let pgAvailable: boolean;
	let pool: pg.Pool | null = null;
	let corpusSourceId: string | null = null;

	beforeAll(async () => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT');
			return;
		}

		// Ensure schema
		const mig = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (mig.exitCode !== 0) {
			throw new Error(`Migration failed: ${mig.stdout} ${mig.stderr}`);
		}

		// Clean + populate corpus once for the integration tests
		cleanTestData();
		cleanStorageFixtures();

		try {
			corpusSourceId = runFullPipeline(NATIVE_TEXT_PDF);
		} catch (e) {
			console.warn(`Could not prepare corpus for integration tests: ${e}`);
		}

		pool = makePool();
	}, 600000);

	afterAll(async () => {
		if (pool) {
			await pool.end();
			pool = null;
		}
		if (pgAvailable) {
			try {
				cleanTestData();
				cleanStorageFixtures();
			} catch {
				// ignore
			}
		}
	});

	// ─── QA-01: Barrel exports ───
	it('QA-01: barrel re-exports hybridRetrieve + helpers + types', async () => {
		const retrievalPkg = await import('@mulder/retrieval');
		expect(typeof retrievalPkg.hybridRetrieve).toBe('function');
		expect(typeof retrievalPkg.extractQueryEntities).toBe('function');
		expect(typeof retrievalPkg.computeQueryConfidence).toBe('function');
	});

	// ─── QA-02: Empty query rejected ───
	it('QA-02: empty query throws RETRIEVAL_INVALID_INPUT without executing strategies', async () => {
		if (!pgAvailable || !pool) return;
		const config = makeConfig();
		const llm = new StubLlmService();
		const embed = new FakeEmbeddingService();

		await expect(hybridRetrieve(pool, embed, llm, config, '   ')).rejects.toBeInstanceOf(RetrievalError);
		try {
			await hybridRetrieve(pool, embed, llm, config, '   ');
		} catch (e) {
			expect(e).toBeInstanceOf(RetrievalError);
			expect((e as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT);
		}
		expect(llm.callCount).toBe(0);
	});

	// ─── QA-03: Invalid strategy rejected ───
	it('QA-03: invalid strategy string throws RETRIEVAL_INVALID_INPUT', async () => {
		if (!pgAvailable || !pool) return;
		const config = makeConfig();
		const llm = new StubLlmService();
		const embed = new FakeEmbeddingService();

		const badOptions = { strategy: 'fuzzy' as unknown as 'vector' };
		await expect(hybridRetrieve(pool, embed, llm, config, 'hello', badOptions)).rejects.toBeInstanceOf(RetrievalError);
		try {
			await hybridRetrieve(pool, embed, llm, config, 'hello', badOptions);
		} catch (e) {
			expect((e as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT);
		}
	});

	// ─── QA-04: Invalid topK rejected ───
	it('QA-04: topK must be a positive integer', async () => {
		if (!pgAvailable || !pool) return;
		const config = makeConfig();
		const llm = new StubLlmService();
		const embed = new FakeEmbeddingService();

		for (const bad of [0, -5, 1.5]) {
			try {
				await hybridRetrieve(pool, embed, llm, config, 'hello', { topK: bad });
				throw new Error('expected throw');
			} catch (e) {
				expect(e).toBeInstanceOf(RetrievalError);
				expect((e as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT);
			}
		}
	});

	// ─── QA-05: Error code registered ───
	it('QA-05: RETRIEVAL_ORCHESTRATOR_FAILED is registered in RETRIEVAL_ERROR_CODES', () => {
		expect(RETRIEVAL_ERROR_CODES.RETRIEVAL_ORCHESTRATOR_FAILED).toBe('RETRIEVAL_ORCHESTRATOR_FAILED');
	});

	// ─── QA-06: hybrid mode runs all three strategies ───
	it('QA-06: hybrid mode returns results with contributions against an indexed corpus (via CLI)', () => {
		if (!pgAvailable || !corpusSourceId) return;
		const { exitCode, stdout, stderr } = runCli(['query', 'UFO', '--json'], { timeout: 60000 });
		expect(exitCode, `stderr: ${stderr}`).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.strategy).toBe('hybrid');
		expect(parsed.results.length).toBeGreaterThanOrEqual(0); // may be 0 if corpus has no hits
		if (parsed.results.length > 0) {
			const first = parsed.results[0];
			expect(typeof first?.content).toBe('string');
			expect(typeof first?.rerankScore).toBe('number');
			expect(Array.isArray(first?.contributions)).toBe(true);
		}
	});

	// ─── QA-07: --strategy vector skips fulltext/graph ───
	it('QA-07: --strategy vector populates only the vector key in explain.counts', () => {
		if (!pgAvailable || !corpusSourceId) return;
		const { exitCode, stdout, stderr } = runCli(
			['query', 'ufo sighting', '--strategy', 'vector', '--explain', '--json'],
			{ timeout: 60000 },
		);
		expect(exitCode, `stderr: ${stderr}`).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.strategy).toBe('vector');
		const keys = Object.keys(parsed.explain.counts);
		expect(keys.length).toBeLessThanOrEqual(1);
		if (keys.length === 1) expect(keys[0]).toBe('vector');
		expect(parsed.explain.seedEntityIds).toEqual([]);
	});

	// ─── QA-08: --strategy fulltext skips vector/graph ───
	it('QA-08: --strategy fulltext populates only the fulltext key in explain.counts', () => {
		if (!pgAvailable || !corpusSourceId) return;
		const { exitCode, stdout } = runCli(['query', 'ufo sighting', '--strategy', 'fulltext', '--explain', '--json'], {
			timeout: 60000,
		});
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.strategy).toBe('fulltext');
		const keys = Object.keys(parsed.explain.counts);
		expect(keys.length).toBeLessThanOrEqual(1);
		if (keys.length === 1) expect(keys[0]).toBe('fulltext');
	});

	// ─── QA-09: --strategy graph uses extracted seeds ───
	it('QA-09: --strategy graph uses extracted seed entities when a known alias appears', async () => {
		if (!pgAvailable || !corpusSourceId || !pool) return;
		// Ensure there is at least one queryable alias. Dev-mode enrich may produce
		// entities without aliases, so we insert a synthetic alias pointing at an
		// existing entity if one isn't already present.
		let alias = db.runSql('SELECT alias FROM entity_aliases LIMIT 1;');
		if (!alias) {
			const entityId = db.runSql('SELECT id FROM entities LIMIT 1;');
			if (!entityId) {
				console.warn('SKIP QA-09: no entities in corpus');
				return;
			}
			db.runSql(`INSERT INTO entity_aliases (entity_id, alias, source) VALUES ('${entityId}', 'ZorkTest', 'manual');`);
			alias = 'ZorkTest';
		}
		const { exitCode, stdout, stderr } = runCli(['query', alias, '--strategy', 'graph', '--explain', '--json'], {
			timeout: 60000,
		});
		expect(exitCode, `stderr: ${stderr}`).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.strategy).toBe('graph');
		expect(parsed.explain.seedEntityIds.length).toBeGreaterThanOrEqual(1);
	});

	// ─── QA-10: graph skipped when no seeds ───
	it('QA-10: graph strategy is skipped (no_seeds) when no query term matches an entity', () => {
		if (!pgAvailable || !corpusSourceId) return;
		const { exitCode, stdout } = runCli(
			['query', 'zzzz absolutely nothing matches', '--strategy', 'hybrid', '--explain', '--json'],
			{ timeout: 60000 },
		);
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.explain.seedEntityIds).toEqual([]);
		expect(parsed.explain.skipped).toContain('graph:no_seeds');
		expect(parsed.explain.counts).not.toHaveProperty('graph');
	});

	// ─── QA-11: --no-rerank bypasses the LLM ───
	it('QA-11: noRerank=true returns passthrough results without calling the LLM', async () => {
		if (!pgAvailable || !pool || !corpusSourceId) return;
		const config = makeConfig();
		const llm = new StubLlmService();
		const embed = new FakeEmbeddingService();

		const result = await hybridRetrieve(pool, embed, llm, config, 'ufo sighting', {
			strategy: 'fulltext',
			noRerank: true,
		});

		expect(llm.callCount).toBe(0);
		// When results exist, rerankScore should equal the original score
		for (const r of result.results) {
			expect(r.rerankScore).toBe(r.score);
		}
	});

	// ─── QA-12: --explain populates contributions ───
	it('QA-12: --explain populates contributions with per-strategy breakdowns', () => {
		if (!pgAvailable || !corpusSourceId) return;
		// Use a query that matches the dev fixture content ("test" appears in the
		// extracted text), so fulltext returns at least one hit.
		const { exitCode, stdout } = runCli(['query', 'test', '--strategy', 'fulltext', '--explain', '--json'], {
			timeout: 60000,
		});
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		if (parsed.results.length === 0) {
			throw new Error('QA-12: expected fulltext hits for query "test" against dev fixture but got none');
		}
		const contribs = parsed.explain.contributions;
		expect(Array.isArray(contribs)).toBe(true);
		const first = contribs?.[0];
		expect(first).toBeDefined();
		expect(typeof first?.chunkId).toBe('string');
		expect(typeof first?.rerankScore).toBe('number');
		expect(typeof first?.rrfScore).toBe('number');
		expect(Array.isArray(first?.strategies)).toBe(true);
		expect(first?.strategies.length).toBeGreaterThanOrEqual(1);
	});

	// ─── QA-13: confidence.corpus_size matches SQL truth ───
	it('QA-13: confidence.corpus_size matches SELECT COUNT(*) FROM sources WHERE status != ingested', () => {
		if (!pgAvailable || !corpusSourceId) return;
		const sqlCount = Number.parseInt(db.runSql("SELECT COUNT(*) FROM sources WHERE status != 'ingested';"), 10);
		const { exitCode, stdout } = runCli(['query', 'ufo', '--strategy', 'fulltext', '--json'], { timeout: 60000 });
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.confidence.corpus_size).toBe(sqlCount);
	});

	// ─── QA-14: taxonomy_status classification by threshold ───
	it('QA-14: computeQueryConfidence classifies bootstrapping when corpus_size below threshold', async () => {
		if (!pgAvailable || !pool) return;
		const config = makeConfig();
		// Force a known threshold
		config.thresholds.taxonomy_bootstrap = 25;

		// We cannot easily guarantee an exact corpus of 3 without disturbing the shared fixture,
		// but the existing populated corpus has a small number of sources (< 25). Verify classification.
		const sqlCount = Number.parseInt(db.runSql("SELECT COUNT(*) FROM sources WHERE status != 'ingested';"), 10);
		if (sqlCount === 0 || sqlCount >= 25) {
			console.warn(`SKIP QA-14: corpus size ${sqlCount} is not in bootstrapping range (1..24)`);
			return;
		}
		const confidence = await computeQueryConfidence(pool, config, { graphHitCount: 0 });
		expect(confidence.taxonomy_status).toBe('bootstrapping');
		expect(confidence.degraded).toBe(true);
	});

	// ─── QA-15: graph_density is 0 when no entities ───
	it('QA-15: graph_density === 0 when entities table is empty', async () => {
		if (!pgAvailable || !pool) return;
		// This test needs isolation — snapshot then restore to avoid trashing the shared corpus
		const savedEntitiesCount = Number.parseInt(db.runSql('SELECT COUNT(*) FROM entities;'), 10);
		if (savedEntitiesCount === 0) {
			// Already empty — just run the test
			const confidence = await computeQueryConfidence(pool, makeConfig(), { graphHitCount: 0 });
			expect(confidence.graph_density).toBe(0);
			return;
		}
		// Non-destructive: verify the formula on its own using raw SQL
		const edgeCount = Number.parseInt(db.runSql('SELECT COUNT(*) FROM entity_edges;'), 10);
		const expectedDensity = edgeCount / savedEntitiesCount;
		const confidence = await computeQueryConfidence(pool, makeConfig(), { graphHitCount: 1 });
		expect(confidence.graph_density).toBeCloseTo(expectedDensity, 6);
	});

	// ─── QA-16: orchestrator tolerates partial-strategy failure ───
	it('QA-16: orchestrator succeeds when vector throws but fulltext returns results', async () => {
		if (!pgAvailable || !pool || !corpusSourceId) return;
		const config = makeConfig();
		const llm = new StubLlmService();
		const brokenEmbed = new ThrowingEmbeddingService();

		// Use a query with no entity match so graph is skipped
		const result = await hybridRetrieve(pool, brokenEmbed, llm, config, 'zzzz nothing matches entities', {
			strategy: 'hybrid',
			noRerank: true,
		});

		// vector must appear in failures
		expect(result.explain.failures.vector).toBeDefined();
		// graph must be skipped
		expect(result.explain.skipped).toContain('graph:no_seeds');
		// No throw — result returned successfully (results may be 0 or more)
		expect(result).toBeDefined();
	});

	// ─── QA-17: all strategies fail/skip ───
	it('QA-17: orchestrator throws RETRIEVAL_ORCHESTRATOR_FAILED when every active strategy fails/skips', async () => {
		if (!pgAvailable || !pool) return;
		const config = makeConfig();
		const llm = new StubLlmService();
		const brokenEmbed = new ThrowingEmbeddingService();

		// strategy: 'vector' with throwing embedding → the single active strategy fails
		// This is the cleanest way to trigger the all-fail path from the public API
		// (fulltext cannot be forced to fail without modifying the query string in a way
		// that pg plainto_tsquery would still parse gracefully).
		try {
			await hybridRetrieve(pool, brokenEmbed, llm, config, 'hello world', { strategy: 'vector' });
			throw new Error('expected orchestrator to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(RetrievalError);
			expect((e as RetrievalError).code).toBe(RETRIEVAL_ERROR_CODES.RETRIEVAL_ORCHESTRATOR_FAILED);
		}
	});

	// ─── QA-18: extractQueryEntities dedupes ───
	it('QA-18: extractQueryEntities deduplicates by entity id', async () => {
		if (!pgAvailable || !pool || !corpusSourceId) return;
		// Ensure a queryable alias exists. Dev-mode enrich may not create aliases,
		// so we insert one pointing at an existing entity if needed.
		let alias = db.runSql('SELECT alias FROM entity_aliases LIMIT 1;');
		if (!alias) {
			const entityId = db.runSql('SELECT id FROM entities LIMIT 1;');
			if (!entityId) {
				console.warn('SKIP QA-18: no entities in corpus');
				return;
			}
			db.runSql(
				`INSERT INTO entity_aliases (entity_id, alias, source) VALUES ('${entityId}', 'QuibbleWord', 'manual') ON CONFLICT DO NOTHING;`,
			);
			alias = 'QuibbleWord';
		}
		// Construct a query that mentions the alias twice
		const seeds = await extractQueryEntities(pool, `what about ${alias} and ${alias} again`);
		// The same id must appear exactly once
		const unique = new Set(seeds);
		expect(unique.size).toBe(seeds.length);
		expect(seeds.length).toBeLessThanOrEqual(1);
	});

	// ─── QA-19: extractQueryEntities empty ───
	it('QA-19: extractQueryEntities returns [] when no aliases match', async () => {
		if (!pgAvailable || !pool) return;
		const seeds = await extractQueryEntities(pool, 'a random nonsense string zzzyxxx');
		expect(Array.isArray(seeds)).toBe(true);
		expect(seeds.length).toBe(0);
	});

	// ─── QA-20: degraded flag reflects graph hit count ───
	it('QA-20: computeQueryConfidence sets degraded=true when graphHitCount === 0', async () => {
		if (!pgAvailable || !pool) return;
		const config = makeConfig();
		const confidence: QueryConfidence = await computeQueryConfidence(pool, config, { graphHitCount: 0 });
		expect(confidence.degraded).toBe(true);
	});

	// ─── QA-21: Results sorted by rerankScore descending ───
	it('QA-21: --json results sorted by rerankScore descending with contiguous 1..N ranks', () => {
		if (!pgAvailable || !corpusSourceId) return;
		const { exitCode, stdout } = runCli(['query', 'ufo', '--strategy', 'fulltext', '--json'], { timeout: 60000 });
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		for (let i = 0; i < parsed.results.length; i++) {
			expect(parsed.results[i]?.rank).toBe(i + 1);
			if (i + 1 < parsed.results.length) {
				expect(parsed.results[i]?.rerankScore).toBeGreaterThanOrEqual(parsed.results[i + 1]?.rerankScore ?? 0);
			}
		}
	});

	// ─── QA-22: topK truncates ───
	it('QA-22: --top-k N truncates final results to at most N', () => {
		if (!pgAvailable || !corpusSourceId) return;
		const { exitCode, stdout } = runCli(['query', 'ufo', '--top-k', '3', '--json'], { timeout: 60000 });
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.topK).toBe(3);
		expect(parsed.results.length).toBeLessThanOrEqual(3);
	});

	// ─── QA-23: rerank.min_score = 0 (default) preserves the existing return contract ───

	it('QA-23: default min_score=0 returns the full result list (no gating)', async () => {
		if (!pgAvailable || !pool || !corpusSourceId) return;
		const config = makeConfig();
		expect(config.retrieval.rerank.min_score).toBe(0);

		const llm = new StubLlmService();
		llm.setResponse({ rankings: [] });
		const embed = new FakeEmbeddingService();

		const result = await hybridRetrieve(pool, embed, llm, config, 'test', {
			strategy: 'fulltext',
		});

		expect(result.confidence.message).toBeUndefined();
	});

	// ─── QA-24: gate triggers on degraded query with low top rerank score ───

	it('QA-24: degraded query with top rerank score below min_score returns empty results + message', async () => {
		if (!pgAvailable || !pool || !corpusSourceId) return;

		// Inject a deterministic chunk we can control. Using a unique
		// queryWord ensures the fulltext hit is exactly what we expect,
		// independent of whatever else lives in the test corpus.
		const queryWord = `qa24token${Date.now()}`;
		const sourceId = '24242424-2424-2424-2424-242424242424';
		const storyId = '24242424-2424-2424-2424-242424240001';
		const chunkId = '24242424-2424-2424-2424-242424240002';

		db.runSql(
			`INSERT INTO sources (id, filename, file_hash, storage_path, page_count, status) VALUES ` +
				`('${sourceId}', 'qa24-gating.pdf', 'qa24-${Date.now()}', 'raw/qa24.pdf', 1, 'graphed');`,
		);
		db.runSql(
			`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) VALUES ` +
				`('${storyId}', '${sourceId}', 'qa24-story', 's/qa24.md', 's/qa24.meta.json', 'graphed');`,
		);
		// Generate a deterministic 768-dim embedding (all zeros + first dim 0.5).
		const vec = `[0.5${',0'.repeat(767)}]`;
		db.runSql(
			`INSERT INTO chunks (id, story_id, content, chunk_index, embedding) VALUES ` +
				`('${chunkId}', '${storyId}', 'A passage containing the unique token ${queryWord}.', 0, '${vec}');`,
		);

		try {
			// Force the query to be degraded by setting taxonomy_bootstrap above
			// any plausible corpus_size. Set min_score to 0.5 so the stub's 0.1
			// relevance scores fall below the floor.
			const config = makeConfig((c) => {
				c.thresholds.taxonomy_bootstrap = 999_999;
				c.retrieval.rerank.min_score = 0.5;
			});

			const llm = new StubLlmService();
			const embed = new FakeEmbeddingService();

			llm.setResponse({
				rankings: [{ passage_id: chunkId, relevance_score: 0.1 }],
			});

			const result = await hybridRetrieve(pool, embed, llm, config, queryWord, {
				strategy: 'fulltext',
			});

			expect(result.confidence.degraded).toBe(true);
			expect(result.results).toEqual([]);
			expect(result.confidence.message).toBe('no_meaningful_matches');
		} finally {
			db.runSql(
				`DELETE FROM chunks WHERE id = '${chunkId}';` +
					` DELETE FROM stories WHERE id = '${storyId}';` +
					` DELETE FROM sources WHERE id = '${sourceId}';`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: query', () => {
	// ─── CLI-01: --help lists all flags ───
	it('CLI-01: mulder query --help prints usage with all flags', () => {
		const { exitCode, stdout } = runCli(['query', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('query');
		expect(stdout).toContain('--strategy');
		expect(stdout).toContain('--top-k');
		expect(stdout).toContain('--no-rerank');
		expect(stdout).toContain('--explain');
		expect(stdout).toContain('--json');
	});

	// ─── CLI-02: Missing question argument ───
	it('CLI-02: missing <question> argument exits non-zero', () => {
		const { exitCode, stderr, stdout } = runCli(['query']);
		expect(exitCode).not.toBe(0);
		expect((stderr + stdout).toLowerCase()).toMatch(/missing|required|argument/);
	});

	// ─── CLI-03: Empty-string question ───
	it('CLI-03: empty-string <question> errors cleanly with no stack trace', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;
		const { exitCode, stdout, stderr } = runCli(['query', '']);
		expect(exitCode).not.toBe(0);
		const combined = (stdout + stderr).toLowerCase();
		expect(combined).toMatch(/question|empty|must not/);
	});

	// ─── CLI-04: Invalid --strategy ───
	it('CLI-04: invalid --strategy value errors cleanly', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;
		const { exitCode, stdout, stderr } = runCli(['query', 'test', '--strategy', 'bogus']);
		expect(exitCode).not.toBe(0);
		const combined = (stdout + stderr).toLowerCase();
		expect(combined).toContain('strategy');
		expect(combined).toMatch(/vector|fulltext|graph|hybrid/);
	});

	// ─── CLI-05: --json is parseable ───
	it('CLI-05: --json output is parseable JSON with expected shape', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;
		const { exitCode, stdout } = runCli(['query', 'test', '--json'], { timeout: 60000 });
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<Record<string, unknown>>(stdout);
		expect(parsed).toHaveProperty('query');
		expect(parsed).toHaveProperty('strategy');
		expect(parsed).toHaveProperty('topK');
		expect(parsed).toHaveProperty('results');
		expect(parsed).toHaveProperty('confidence');
		expect(parsed).toHaveProperty('explain');
	});

	// ─── CLI-06: Text mode renders ───
	it('CLI-06: text mode prints query + results header', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;
		const { exitCode, stdout } = runCli(['query', 'test'], { timeout: 60000 });
		expect(exitCode).toBe(0);
		expect(stdout).toContain('test');
		expect(stdout.toLowerCase()).toMatch(/results|strategy|confidence/);
	});

	// ─── CLI-07: --explain text mode ───
	it('CLI-07: --explain text mode prints per-result strategy breakdowns when hits exist', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;
		const { exitCode, stdout } = runCli(['query', 'ufo', '--explain'], { timeout: 60000 });
		expect(exitCode).toBe(0);
		// Either text mode printed an explain breakdown or no results (both are fine)
		// When results exist, we expect at least one of the strategy words to appear.
		expect(stdout.toLowerCase()).toMatch(/strategy|confidence|vector|fulltext|graph/);
	});

	// ─── CLI-08: Empty-result query does not crash ───
	it('CLI-08: query with guaranteed-no-match does not crash', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;
		const { exitCode, stdout } = runCli(['query', 'xyznonsense12345', '--json'], { timeout: 60000 });
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(Array.isArray(parsed.results)).toBe(true);
		expect(parsed.confidence.degraded).toBe(true);
	});

	// ─── CLI-09: --top-k 1 --strategy vector ───
	it('CLI-09: --top-k 1 --strategy vector returns at most 1 vector-only result', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;
		const { exitCode, stdout } = runCli(['query', 'test', '--top-k', '1', '--strategy', 'vector', '--json'], {
			timeout: 60000,
		});
		expect(exitCode).toBe(0);
		const parsed = parseCliJson<HybridRetrievalResult>(stdout);
		expect(parsed.strategy).toBe('vector');
		expect(parsed.results.length).toBeLessThanOrEqual(1);
	});
});
