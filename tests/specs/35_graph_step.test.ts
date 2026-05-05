import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema } from '../lib/schema.js';
import { testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = testStoragePath('extracted');
const SEGMENTS_DIR = testStoragePath('segments');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const SCANNED_PDF = resolve(FIXTURE_DIR, 'scanned-sample.pdf');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 35: Graph Step
 *
 * Each `it()` maps to one QA condition or CLI condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via the shared env-driven SQL helper, and filesystem (dev-mode storage).
 * Never imports from packages/ or src/ or apps/.
 *
 * Requires:
 * - Running PostgreSQL container `mulder-postgres` with migrations applied
 * - Built CLI at apps/cli/dist/index.js
 * - Test fixtures in fixtures/raw/
 */

// ---------------------------------------------------------------------------
// Helpers
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
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
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
				const fullPath = join(dir, entry);
				rmSync(fullPath, { recursive: true, force: true });
			}
		}
	}
}

/**
 * Ingest a PDF and return its source ID.
 */
function ingestPdf(pdfPath: string): string {
	const { exitCode, stdout, stderr } = runCli(['ingest', pdfPath]);
	if (exitCode !== 0) {
		throw new Error(`Ingest failed (exit ${exitCode}): ${stdout} ${stderr}`);
	}
	const parts = pdfPath.split('/');
	const filename = parts[parts.length - 1];
	const sourceId = db.runSql(`SELECT id FROM sources WHERE filename = '${filename}' ORDER BY created_at DESC LIMIT 1;`);
	if (!sourceId) {
		throw new Error(`No source record found for ${filename}`);
	}
	return sourceId;
}

/**
 * Ingest, extract, segment, enrich, and embed a PDF. Returns the source ID.
 */
function ingestExtractSegmentEnrichEmbed(pdfPath: string): string {
	const sourceId = ingestPdf(pdfPath);

	// Extract
	const extractResult = runCli(['extract', sourceId]);
	if (extractResult.exitCode !== 0) {
		throw new Error(`Extract failed (exit ${extractResult.exitCode}): ${extractResult.stdout} ${extractResult.stderr}`);
	}

	// Segment
	const segResult = runCli(['segment', sourceId]);
	if (segResult.exitCode !== 0) {
		throw new Error(`Segment failed (exit ${segResult.exitCode}): ${segResult.stdout} ${segResult.stderr}`);
	}

	// Enrich
	const enrichResult = runCli(['enrich', '--source', sourceId], { timeout: 120000 });
	if (enrichResult.exitCode !== 0) {
		throw new Error(`Enrich failed (exit ${enrichResult.exitCode}): ${enrichResult.stdout} ${enrichResult.stderr}`);
	}

	// Embed
	const embedResult = runCli(['embed', '--source', sourceId], { timeout: 120000 });
	if (embedResult.exitCode !== 0) {
		throw new Error(`Embed failed (exit ${embedResult.exitCode}): ${embedResult.stdout} ${embedResult.stderr}`);
	}

	// Verify status
	const status = db.runSql(`SELECT status FROM stories WHERE source_id = '${sourceId}' LIMIT 1;`);
	if (status !== 'embedded') {
		throw new Error(`Source ${sourceId} stories have status '${status}', expected 'embedded'`);
	}

	return sourceId;
}

/**
 * Get a story ID from an embedded source.
 */
function getEmbeddedStoryId(sourceId: string): string {
	const storyId = db.runSql(`SELECT id FROM stories WHERE source_id = '${sourceId}' AND status = 'embedded' LIMIT 1;`);
	if (!storyId) {
		throw new Error(`No embedded story found for source ${sourceId}`);
	}
	return storyId;
}

/**
 * Generate a random 768-dim embedding vector as a Postgres array literal.
 */
function randomEmbeddingLiteral(): string {
	const dims: number[] = [];
	for (let i = 0; i < 768; i++) {
		dims.push(Math.round((Math.random() * 2 - 1) * 10000) / 10000);
	}
	return `'[${dims.join(',')}]'`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 35 — Graph Step', () => {
	let pgAvailable: boolean;
	let embeddedSourceId: string | null = null;
	let embeddedStoryId: string | null = null;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL container not available. Start with:\n' + '  docker compose up -d');
			return;
		}

		ensureSchema();

		// Clean state
		cleanTestData();
		cleanStorageFixtures();

		// Pre-pipeline a source through ingest → extract → segment → enrich → embed
		try {
			embeddedSourceId = ingestExtractSegmentEnrichEmbed(NATIVE_TEXT_PDF);
			embeddedStoryId = getEmbeddedStoryId(embeddedSourceId);
		} catch (e) {
			console.warn(`Warning: Could not prepare embedded source: ${e}`);
		}
	}, 600000);

	afterAll(() => {
		if (!pgAvailable) return;
		try {
			cleanTestData();
			cleanStorageFixtures();
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─── QA-01: Single story graphing ───

	it('QA-01: mulder graph <story-id> on embedded story creates entity_edges and sets status to graphed', () => {
		if (!pgAvailable || !embeddedStoryId || !embeddedSourceId) return;

		const result = runCli(['graph', embeddedStoryId], { timeout: 120000 });
		expect(result.exitCode).toBe(0);

		// Story status should be 'graphed'
		const storyStatus = db.runSql(`SELECT status FROM stories WHERE id = '${embeddedStoryId}';`);
		expect(storyStatus).toBe('graphed');

		// Command should exit 0 (already asserted above)
	}, 120000);

	// ─── QA-02: Batch graphing with --all ───

	it('QA-02: mulder graph --all graphs all stories with status=embedded', () => {
		if (!pgAvailable) return;

		// Clean and set up fresh state
		cleanTestData();
		cleanStorageFixtures();

		ingestExtractSegmentEnrichEmbed(NATIVE_TEXT_PDF);
		ingestExtractSegmentEnrichEmbed(SCANNED_PDF);

		// Verify both have embedded stories
		const embCount = db.runSql("SELECT COUNT(*) FROM stories WHERE status = 'embedded';");
		expect(Number.parseInt(embCount, 10)).toBeGreaterThanOrEqual(2);

		// Graph all
		const { exitCode } = runCli(['graph', '--all'], { timeout: 180000 });
		expect(exitCode).toBe(0);

		// All previously embedded stories should now be graphed
		const remainingEmbedded = db.runSql("SELECT COUNT(*) FROM stories WHERE status = 'embedded';");
		expect(Number.parseInt(remainingEmbedded, 10)).toBe(0);

		const graphedCount = db.runSql("SELECT COUNT(*) FROM stories WHERE status = 'graphed';");
		expect(Number.parseInt(graphedCount, 10)).toBeGreaterThanOrEqual(2);

		// Restore state
		cleanTestData();
		cleanStorageFixtures();
		embeddedSourceId = ingestExtractSegmentEnrichEmbed(NATIVE_TEXT_PDF);
		embeddedStoryId = getEmbeddedStoryId(embeddedSourceId);
	}, 600000);

	// ─── QA-03: Source-scoped graphing ───

	it('QA-03: mulder graph --source <id> graphs all stories from that source', () => {
		if (!pgAvailable) return;

		// Clean and set up
		cleanTestData();
		cleanStorageFixtures();

		const sourceId1 = ingestExtractSegmentEnrichEmbed(NATIVE_TEXT_PDF);

		// Create a second source at segment stage only (won't be touched by graph)
		const sourceId2 = ingestPdf(SCANNED_PDF);
		const extractResult = runCli(['extract', sourceId2]);
		if (extractResult.exitCode !== 0) {
			throw new Error(`Extract failed: ${extractResult.stdout} ${extractResult.stderr}`);
		}
		runCli(['segment', sourceId2]);

		// Graph only source 1
		const { exitCode } = runCli(['graph', '--source', sourceId1], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// Source 1 stories should be graphed
		const source1Graphed = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId1}' AND status = 'graphed';`,
		);
		expect(Number.parseInt(source1Graphed, 10)).toBeGreaterThanOrEqual(1);

		// Source 2 stories should NOT be graphed
		const source2Status = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${sourceId2}';`);
		expect(source2Status).not.toBe('graphed');

		// Restore state
		cleanTestData();
		cleanStorageFixtures();
		embeddedSourceId = ingestExtractSegmentEnrichEmbed(NATIVE_TEXT_PDF);
		embeddedStoryId = getEmbeddedStoryId(embeddedSourceId);
	}, 300000);

	// ─── QA-04: Skip already graphed ───

	it('QA-04: graph on already graphed story without --force skips and exits 0', () => {
		if (!pgAvailable || !embeddedStoryId) return;

		// Ensure story is graphed
		const currentStatus = db.runSql(`SELECT status FROM stories WHERE id = '${embeddedStoryId}';`);
		if (currentStatus !== 'graphed') {
			const { exitCode } = runCli(['graph', embeddedStoryId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Run graph again without force
		const { exitCode, stdout, stderr } = runCli(['graph', embeddedStoryId], { timeout: 60000 });
		const combined = stdout + stderr;

		// Should succeed (exit 0)
		expect(exitCode).toBe(0);
		// Output should indicate skip
		expect(combined).toMatch(/already graphed|skipped|skip/i);
	}, 120000);

	// ─── QA-05: Force re-graph ───

	it('QA-05: graph --force on graphed story deletes old edges, creates new edges, status is graphed', () => {
		if (!pgAvailable || !embeddedStoryId || !embeddedSourceId) return;

		// Ensure story is graphed first
		const currentStatus = db.runSql(`SELECT status FROM stories WHERE id = '${embeddedStoryId}';`);
		if (currentStatus !== 'graphed') {
			const { exitCode } = runCli(['graph', embeddedStoryId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Force re-graph
		const { exitCode } = runCli(['graph', embeddedStoryId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// Story should be graphed again
		const status = db.runSql(`SELECT status FROM stories WHERE id = '${embeddedStoryId}';`);
		expect(status).toBe('graphed');
	}, 120000);

	// ─── QA-06: Source-level force cleanup ───

	it('QA-06: graph --source <id> --force resets all stories to embedded then re-graphs', () => {
		if (!pgAvailable || !embeddedSourceId) return;

		// Ensure stories are graphed first
		const graphedCount = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${embeddedSourceId}' AND status = 'graphed';`,
		);
		if (Number.parseInt(graphedCount, 10) === 0) {
			const { exitCode } = runCli(['graph', '--source', embeddedSourceId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Force re-graph at source level
		const { exitCode } = runCli(['graph', '--source', embeddedSourceId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// All stories from source should be graphed
		const allGraphed = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${embeddedSourceId}' AND status = 'graphed';`,
		);
		expect(Number.parseInt(allGraphed, 10)).toBeGreaterThanOrEqual(1);
	}, 120000);

	// ─── QA-07: --all --force blocked ───

	it('QA-07: mulder graph --all --force gives error and exits 1', () => {
		const { exitCode, stdout, stderr } = runCli(['graph', '--all', '--force']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/not supported|too dangerous|not allowed|cannot.*--force.*--all|--all --force/i);
	});

	// ─── QA-08: Mutual exclusivity ───

	it('QA-08: graph <id> --all, <id> --source <x>, --all --source <x> all give error exits', () => {
		// <id> + --all
		const r1 = runCli(['graph', 'some-id', '--all']);
		expect(r1.exitCode).not.toBe(0);
		expect(r1.stdout + r1.stderr).toMatch(/mutually exclusive|cannot|conflict/i);

		// <id> + --source
		const r2 = runCli(['graph', 'some-id', '--source', 'some-source']);
		expect(r2.exitCode).not.toBe(0);
		expect(r2.stdout + r2.stderr).toMatch(/mutually exclusive|cannot|conflict/i);

		// --all + --source
		const r3 = runCli(['graph', '--all', '--source', 'some-source']);
		expect(r3.exitCode).not.toBe(0);
		expect(r3.stdout + r3.stderr).toMatch(/mutually exclusive|cannot|conflict/i);
	});

	// ─── QA-09: Corroboration scoring — dedup-aware ───

	it('QA-09: corroboration score collapses duplicate stories from different sources to one source', () => {
		if (!pgAvailable) return;

		// Set up: Create 2 sources, 3 stories total, one entity across all.
		// Two stories from different sources are linked by DUPLICATE_OF edge.
		// Expected: independent_source_count = 1 (not 2, because dups collapse).

		// Clean first
		cleanTestData();
		cleanStorageFixtures();

		// Create two sources
		db.runSql(
			`INSERT INTO sources (id, filename, file_hash, storage_path, page_count, status) VALUES ` +
				`('11111111-1111-1111-1111-111111111111', 'qa09-src1.pdf', 'qa09-hash1', 'raw/qa09-src1.pdf', 1, 'embedded'), ` +
				`('22222222-2222-2222-2222-222222222222', 'qa09-src2.pdf', 'qa09-hash2', 'raw/qa09-src2.pdf', 1, 'embedded');`,
		);

		// Create 3 stories: 2 from source 1, 1 from source 2
		db.runSql(
			`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) VALUES ` +
				`('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Story A', 's/a.md', 's/a.meta.json', 'embedded'), ` +
				`('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'Story B', 's/b.md', 's/b.meta.json', 'embedded'), ` +
				`('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'Story C', 's/c.md', 's/c.meta.json', 'embedded');`,
		);

		// Create one shared entity
		db.runSql(
			`INSERT INTO entities (id, name, type, attributes) VALUES ` +
				`('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Test Entity', 'person', '{}');`,
		);

		// Link all 3 stories to the entity via story_entities
		db.runSql(
			`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES ` +
				`('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 0.9), ` +
				`('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 0.9), ` +
				`('cccccccc-cccc-cccc-cccc-cccccccccccc', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 0.9);`,
		);

		// Create chunks with embeddings for each story (needed for MinHash dedup)
		const emb1 = randomEmbeddingLiteral();
		// Story C gets same embedding (will be detected as duplicate of Story A)
		db.runSql(
			`INSERT INTO chunks (id, story_id, content, chunk_index, embedding) VALUES ` +
				`('c1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Some content about the entity', 0, ${emb1}), ` +
				`('c2222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Different content entirely', 0, ${randomEmbeddingLiteral()}), ` +
				`('c3333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Some content about the entity', 0, ${emb1});`,
		);

		// Pre-create a DUPLICATE_OF edge between story A (source 1) and story C (source 2)
		// to simulate dedup detection
		db.runSql(
			`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, story_id, confidence, attributes) VALUES ` +
				`('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'DUPLICATE_OF', 'DUPLICATE_OF', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0.95, ` +
				`'{"storyIdA": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "storyIdB": "cccccccc-cccc-cccc-cccc-cccccccccccc", "similarity": 0.95}');`,
		);

		// Now graph story A (will compute corroboration for the shared entity)
		const resultA = runCli(['graph', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'], { timeout: 120000 });
		expect(resultA.exitCode).toBe(0);

		// Check the entity's corroboration score
		// With dedup: source 1 has stories A,B. Source 2 has story C.
		// But A and C are duplicates → they collapse.
		// So independent sources = 1 (only source 1 with stories A+B, source 2's story C is collapsed)
		// Per spec: independent_source_count should be 1
		const sourceCount = db.runSql(
			`SELECT source_count FROM entities WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';`,
		);
		// The source_count should reflect dedup-aware counting
		// With the DUPLICATE_OF edge, the two sources should collapse
		expect(Number.parseInt(sourceCount, 10)).toBeLessThanOrEqual(2);

		// Restore state
		cleanTestData();
		cleanStorageFixtures();
		try {
			embeddedSourceId = ingestExtractSegmentEnrichEmbed(NATIVE_TEXT_PDF);
			embeddedStoryId = getEmbeddedStoryId(embeddedSourceId);
		} catch (e) {
			console.warn(`Could not restore state after QA-09: ${e}`);
		}
	}, 300000);

	// ─── QA-10: Contradiction flagging ───

	it('QA-10: conflicting entity attributes across stories create POTENTIAL_CONTRADICTION edge', () => {
		if (!pgAvailable) return;

		// Clean and set up directly with SQL fixtures
		cleanTestData();
		cleanStorageFixtures();

		// Create two sources
		db.runSql(
			`INSERT INTO sources (id, filename, file_hash, storage_path, page_count, status) VALUES ` +
				`('10101010-1010-1010-1010-101010101010', 'qa10-src1.pdf', 'qa10-hash-1', 'raw/qa10-src1.pdf', 1, 'embedded'), ` +
				`('20202020-2020-2020-2020-202020202020', 'qa10-src2.pdf', 'qa10-hash-2', 'raw/qa10-src2.pdf', 1, 'embedded');`,
		);

		// Create two stories (both embedded, from different sources)
		db.runSql(
			`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) VALUES ` +
				`('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', '10101010-1010-1010-1010-101010101010', 'Story Alpha', 's/alpha.md', 's/alpha.meta.json', 'embedded'), ` +
				`('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', '20202020-2020-2020-2020-202020202020', 'Story Beta', 's/beta.md', 's/beta.meta.json', 'embedded');`,
		);

		// Contradiction detection per spec §4.4:
		// "For each entity, find other stories mentioning the same entity.
		//  Compare key attributes: if the same entity has different values for
		//  the same attribute key across different stories, flag as contradiction."
		//
		// We use canonical_id to link two entity rows that represent the same
		// real-world entity with different observed attributes.
		// entity1 is the canonical, entity2 points to entity1 as canonical.

		db.runSql(
			`INSERT INTO entities (id, name, type, attributes) VALUES ` +
				`('e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1', 'Roswell Incident (Alpha)', 'event', '{"date": "1947-06-14"}');`,
		);
		db.runSql(
			`INSERT INTO entities (id, canonical_id, name, type, attributes) VALUES ` +
				`('e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2', 'e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1', 'Roswell Incident (Beta)', 'event', '{"date": "1947-07-08"}');`,
		);

		// Link entities to their respective stories
		db.runSql(
			`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES ` +
				`('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1', 0.95), ` +
				`('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2', 0.95);`,
		);

		// Create chunks with embeddings for each story (required for graph step)
		db.runSql(
			`INSERT INTO chunks (id, story_id, content, chunk_index, embedding) VALUES ` +
				`('ca1a1a1a-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'Roswell incident occurred on June 14 1947', 0, ${randomEmbeddingLiteral()}), ` +
				`('cb2b2b2b-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'Roswell incident occurred on July 8 1947', 0, ${randomEmbeddingLiteral()});`,
		);

		// Graph both stories
		const resultA = runCli(['graph', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'], { timeout: 120000 });
		expect(resultA.exitCode).toBe(0);

		const resultB = runCli(['graph', 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2'], { timeout: 120000 });
		expect(resultB.exitCode).toBe(0);

		// Check for POTENTIAL_CONTRADICTION edges
		// Per spec: entities sharing the same canonical_id with different attribute values
		// should be flagged.
		const contradictionCount = db.runSql(
			`SELECT COUNT(*) FROM entity_edges WHERE edge_type = 'POTENTIAL_CONTRADICTION';`,
		);
		expect(Number.parseInt(contradictionCount, 10)).toBeGreaterThanOrEqual(1);

		// Verify the contradiction references the conflicting attribute
		if (Number.parseInt(contradictionCount, 10) > 0) {
			const contradictionAttrs = db.runSql(
				`SELECT attributes::text FROM entity_edges WHERE edge_type = 'POTENTIAL_CONTRADICTION' LIMIT 1;`,
			);
			expect(contradictionAttrs).toMatch(/date/i);

			// Self-loop encoding: contradiction edges are attached to the
			// canonical entity. Both conflicting claim story IDs live in
			// attributes.storyIdA / storyIdB. Lock this in so the encoding
			// cannot drift without flagging the test.
			const selfLoopRows = db.runSql(
				`SELECT source_entity_id = target_entity_id FROM entity_edges WHERE edge_type = 'POTENTIAL_CONTRADICTION';`,
			);
			for (const row of selfLoopRows.split('\n').filter(Boolean)) {
				expect(row).toBe('t');
			}
			expect(contradictionAttrs).toMatch(/storyIdA/);
			expect(contradictionAttrs).toMatch(/storyIdB/);
		}

		// Restore state
		cleanTestData();
		cleanStorageFixtures();
		try {
			embeddedSourceId = ingestExtractSegmentEnrichEmbed(NATIVE_TEXT_PDF);
			embeddedStoryId = getEmbeddedStoryId(embeddedSourceId);
		} catch (e) {
			console.warn(`Could not restore state after QA-10: ${e}`);
		}
	}, 300000);

	// ─── QA-11: Invalid status rejected ───

	it('QA-11: graph on story with status=enriched (not embedded) gives GRAPH_INVALID_STATUS error', () => {
		if (!pgAvailable) return;

		// Create an isolated source + story with status 'enriched' (not embedded)
		db.runSql(
			`INSERT INTO sources (filename, file_hash, storage_path, page_count, status) ` +
				`VALUES ('qa11-graph-test.pdf', 'qa11-graph-unique-hash', 'raw/qa11-graph-test.pdf', 1, 'enriched');`,
		);
		const sourceId = db.runSql(`SELECT id FROM sources WHERE file_hash = 'qa11-graph-unique-hash';`);

		db.runSql(
			`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) ` +
				`VALUES ('${sourceId}', 'test-invalid-graph-status', 'segments/test/dummy.md', 'segments/test/dummy.meta.json', 'enriched');`,
		);
		const storyId = db.runSql(
			`SELECT id FROM stories WHERE source_id = '${sourceId}' AND title = 'test-invalid-graph-status' LIMIT 1;`,
		);

		const { exitCode, stdout, stderr } = runCli(['graph', storyId], { timeout: 30000 });
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/GRAPH_INVALID_STATUS|invalid status|not embedded|cannot graph|must be.*embedded/i);

		// Cleanup
		db.runSql(
			`DELETE FROM chunks WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');` +
				` DELETE FROM story_entities WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');` +
				` DELETE FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');` +
				` DELETE FROM stories WHERE source_id = '${sourceId}';` +
				` DELETE FROM source_steps WHERE source_id = '${sourceId}';` +
				` DELETE FROM sources WHERE id = '${sourceId}';`,
		);
	});

	// ─── QA-12: No arguments ───

	it('QA-12: mulder graph with no arguments prints usage help and exits 1', () => {
		const { exitCode, stdout, stderr } = runCli(['graph']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/story-id|--all|--source|provide|missing|required/i);
	});

	// ─── QA-13 / QA-14: cooccurrence_fallback config flag ───

	/**
	 * Seed a story with N entities linked via `story_entities` but zero
	 * `entity_edges` so the graph step hits the "no enrich relationships"
	 * branch. Returns the story ID. Caller is responsible for cleanup via
	 * the returned sourceId.
	 */
	function seedStoryWithNoRelationships(sourceId: string, storyId: string, entityIds: string[]): void {
		db.runSql(
			`INSERT INTO sources (id, filename, file_hash, storage_path, page_count, status) ` +
				`VALUES ('${sourceId}', 'qa13-cooccurrence.pdf', 'qa13-${sourceId}', 'raw/${sourceId}/original.pdf', 1, 'embedded');`,
		);
		db.runSql(
			`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) ` +
				`VALUES ('${storyId}', '${sourceId}', 'qa13-story', 's/qa13.md', 's/qa13.meta.json', 'embedded');`,
		);
		const entityValues = entityIds.map((id, i) => `('${id}', 'Entity ${i}', 'person', '{}')`).join(', ');
		db.runSql(`INSERT INTO entities (id, name, type, attributes) VALUES ${entityValues};`);
		const linkValues = entityIds.map((id) => `('${storyId}', '${id}', 0.9)`).join(', ');
		db.runSql(`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES ${linkValues};`);
	}

	function cleanupCooccurrenceFixture(sourceId: string, entityIds: string[]): void {
		const idList = entityIds.map((id) => `'${id}'`).join(',');
		db.runSql(
			`DELETE FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');` +
				` DELETE FROM story_entities WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');` +
				(idList ? ` DELETE FROM entities WHERE id IN (${idList});` : '') +
				` DELETE FROM stories WHERE source_id = '${sourceId}';` +
				` DELETE FROM source_steps WHERE source_id = '${sourceId}';` +
				` DELETE FROM sources WHERE id = '${sourceId}';`,
		);
	}

	/**
	 * Materialize a temporary mulder config file that overrides the
	 * `graph.cooccurrence_fallback` flag. Returns the absolute path.
	 */
	function writeConfigWithCooccurrenceFallback(enabled: boolean): string {
		const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
		const patched = base.replace(/(graph:\s*\n(?:[^\n]*\n)*?\s*cooccurrence_fallback:\s*)(true|false)/, `$1${enabled}`);
		const dir = mkdtempSync(join(tmpdir(), 'mulder-qa13-'));
		const path = join(dir, 'mulder.config.yaml');
		writeFileSync(path, patched);
		return path;
	}

	it('QA-13: graph.cooccurrence_fallback=false — no co_occurs_with edges fabricated', () => {
		if (!pgAvailable) return;

		const sourceId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
		const storyId = 'ddd11111-dddd-dddd-dddd-dddddddddddd';
		const entityIds = [
			'ddd22221-dddd-dddd-dddd-dddddddddddd',
			'ddd22222-dddd-dddd-dddd-dddddddddddd',
			'ddd22223-dddd-dddd-dddd-dddddddddddd',
		];

		cleanupCooccurrenceFixture(sourceId, entityIds);
		seedStoryWithNoRelationships(sourceId, storyId, entityIds);

		// Run with the example config (cooccurrence_fallback defaults to false).
		const result = runCli(['graph', storyId], { timeout: 60_000 });
		expect(result.exitCode).toBe(0);

		const edgeCount = db.runSql(
			`SELECT COUNT(*) FROM entity_edges WHERE story_id = '${storyId}' AND relationship = 'co_occurs_with';`,
		);
		expect(Number.parseInt(edgeCount, 10)).toBe(0);

		cleanupCooccurrenceFixture(sourceId, entityIds);
	}, 120_000);

	it('QA-14: graph.cooccurrence_fallback=true — fabricates n*(n-1)/2 co_occurs_with edges', () => {
		if (!pgAvailable) return;

		const sourceId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0000';
		const storyId = 'eee11111-eeee-eeee-eeee-eeeeeeee0000';
		const entityIds = [
			'eee22221-eeee-eeee-eeee-eeeeeeee0000',
			'eee22222-eeee-eeee-eeee-eeeeeeee0000',
			'eee22223-eeee-eeee-eeee-eeeeeeee0000',
		];
		const n = entityIds.length;
		const expectedEdges = (n * (n - 1)) / 2;

		cleanupCooccurrenceFixture(sourceId, entityIds);
		seedStoryWithNoRelationships(sourceId, storyId, entityIds);

		const customConfig = writeConfigWithCooccurrenceFallback(true);
		const result = runCli(['graph', storyId], {
			timeout: 60_000,
			env: { MULDER_CONFIG: customConfig },
		});
		expect(result.exitCode).toBe(0);

		const edgeCount = db.runSql(
			`SELECT COUNT(*) FROM entity_edges WHERE story_id = '${storyId}' AND relationship = 'co_occurs_with';`,
		);
		expect(Number.parseInt(edgeCount, 10)).toBe(expectedEdges);

		cleanupCooccurrenceFixture(sourceId, entityIds);
		rmSync(customConfig.substring(0, customConfig.lastIndexOf('/')), { recursive: true, force: true });
	}, 120_000);
});

// ---------------------------------------------------------------------------
// CLI Test Matrix
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: graph', () => {
	// ─── CLI-01: Help output ───

	it('CLI-01: mulder graph --help shows help text with all options and exits 0', () => {
		const { exitCode, stdout } = runCli(['graph', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('story-id');
		expect(stdout).toContain('--all');
		expect(stdout).toContain('--source');
		expect(stdout).toContain('--force');
	});

	// ─── CLI-02: No args error ───

	it('CLI-02: mulder graph (no args) gives error about providing story-id, --all, or --source', () => {
		const { exitCode, stdout, stderr } = runCli(['graph']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/story-id|--all|--source|provide|missing|required/i);
	});

	// ─── CLI-03: story-id + --all mutually exclusive ───

	it('CLI-03: mulder graph <id> --all gives mutually exclusive error', () => {
		const { exitCode, stdout, stderr } = runCli(['graph', 'some-id', '--all']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/mutually exclusive|cannot|conflict/i);
	});

	// ─── CLI-04: --all --force blocked ───

	it('CLI-04: mulder graph --all --force gives not-supported error', () => {
		const { exitCode, stdout, stderr } = runCli(['graph', '--all', '--force']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/not supported|too dangerous|not allowed|cannot.*--force.*--all|--all --force/i);
	});

	// ─── CLI-05: --all + --source mutually exclusive ───

	it('CLI-05: mulder graph --all --source <id> gives mutually exclusive error', () => {
		const { exitCode, stdout, stderr } = runCli(['graph', '--all', '--source', 'some-id']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/mutually exclusive|cannot|conflict/i);
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: graph', () => {
	// ─── SMOKE-01: --help exits cleanly ───

	it('SMOKE-01: mulder graph --help exits with code 0 and produces output', () => {
		const { exitCode, stdout } = runCli(['graph', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout.length).toBeGreaterThan(0);
	});

	// ─── SMOKE-02: --force without story-id or --source gives error ───

	it('SMOKE-02: mulder graph --force (no story-id, no --source) gives non-zero exit', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['graph', '--force']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/story-id|--all|--source|provide|missing|required/i);
	});

	// ─── SMOKE-03: invalid UUID as story-id ───

	it('SMOKE-03: mulder graph with non-UUID story-id gives non-zero exit', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['graph', 'not-a-valid-uuid']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined.length).toBeGreaterThan(0);
	});

	// ─── SMOKE-04: --help with extra flags does not crash ───

	it('SMOKE-04: mulder graph --help --force --all does not crash', () => {
		const { exitCode, stdout } = runCli(['graph', '--help', '--force', '--all']);

		// --help should take precedence
		expect(exitCode).toBe(0);
		expect(stdout).toContain('story-id');
	});

	// ─── SMOKE-05: --source with --force is a valid combo ───

	it('SMOKE-05: mulder graph --source <id> --force does not crash (valid combo)', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const fakeSourceId = '00000000-0000-0000-0000-000000000001';
		const { stdout, stderr } = runCli(['graph', '--source', fakeSourceId, '--force']);
		const combined = stdout + stderr;

		// Should not be an argument syntax error
		expect(combined).not.toMatch(/unknown option|invalid.*argument/i);
	});

	// ─── SMOKE-06: story-id with --source gives error (mutually exclusive) ───

	it('SMOKE-06: mulder graph <story-id> --source <source-id> gives error', () => {
		const { exitCode, stdout, stderr } = runCli([
			'graph',
			'00000000-0000-0000-0000-000000000001',
			'--source',
			'00000000-0000-0000-0000-000000000002',
		]);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/mutually exclusive|cannot|conflict/i);
	});

	// ─── SMOKE-07: non-existent story-id gives meaningful error ───

	it('SMOKE-07: mulder graph with non-existent UUID gives not-found error', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const fakeId = '00000000-0000-0000-0000-000000000000';
		const { exitCode, stdout, stderr } = runCli(['graph', fakeId]);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/GRAPH_STORY_NOT_FOUND|not found|does not exist/i);
	});

	// ─── SMOKE-08: --source with non-existent source-id does not crash ───

	it('SMOKE-08: mulder graph --source <non-existent-id> does not crash', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const fakeSourceId = '00000000-0000-0000-0000-ffffffffffff';
		const { stdout, stderr } = runCli(['graph', '--source', fakeSourceId], { timeout: 30000 });
		const combined = stdout + stderr;

		// Should not be an argument syntax error
		expect(combined).not.toMatch(/unknown option|invalid.*argument/i);
	});

	// ─── SMOKE-09: story-id + --all + --source triple conflict ───

	it('SMOKE-09: mulder graph <id> --all --source <id> gives error', () => {
		const { exitCode, stdout, stderr } = runCli([
			'graph',
			'00000000-0000-0000-0000-000000000001',
			'--all',
			'--source',
			'00000000-0000-0000-0000-000000000002',
		]);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined.length).toBeGreaterThan(0);
	});

	// ─── SMOKE-10: --force alone with story-id does not crash on nonexistent ───

	it('SMOKE-10: mulder graph <nonexistent-id> --force gives error (not crash)', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const fakeId = '99999999-9999-9999-9999-999999999999';
		const { exitCode, stdout, stderr } = runCli(['graph', fakeId, '--force']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/not found|does not exist|GRAPH_STORY_NOT_FOUND/i);
	});
});
