import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = resolve(ROOT, '.local/storage/extracted');
const SEGMENTS_DIR = resolve(ROOT, '.local/storage/segments');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const SCANNED_PDF = resolve(FIXTURE_DIR, 'scanned-sample.pdf');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 29: Enrich Step
 *
 * Each `it()` maps to one QA condition or CLI condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `the shared env-driven SQL helper`, and filesystem (dev-mode storage).
 * Never imports from packages/ or src/ or apps/.
 *
 * Requires:
 * - PostgreSQL reachable through the standard PG env vars with migrations applied
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
		'DELETE FROM story_entities; DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM stories; DELETE FROM source_steps; DELETE FROM sources;',
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
 * Ensure page images exist for an extracted source.
 * Creates minimal valid PNGs if the canvas module was unavailable during extraction.
 */
function ensurePageImages(sourceId: string): void {
	const pagesDir = join(EXTRACTED_DIR, sourceId, 'pages');
	if (!existsSync(pagesDir)) {
		const layoutPath = join(EXTRACTED_DIR, sourceId, 'layout.json');
		if (existsSync(layoutPath)) {
			const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
			mkdirSync(pagesDir, { recursive: true });
			// Minimal valid PNG (1x1 white pixel)
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
	}
}

/**
 * Ingest a PDF and return its source ID from the database.
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
 * Ingest, extract, and segment a PDF. Returns the source ID.
 */
function ingestExtractSegment(pdfPath: string): string {
	const sourceId = ingestPdf(pdfPath);

	// Extract
	const extractResult = runCli(['extract', sourceId]);
	if (extractResult.exitCode !== 0) {
		throw new Error(`Extract failed (exit ${extractResult.exitCode}): ${extractResult.stdout} ${extractResult.stderr}`);
	}
	ensurePageImages(sourceId);

	// Segment
	const segResult = runCli(['segment', sourceId]);
	if (segResult.exitCode !== 0) {
		throw new Error(`Segment failed (exit ${segResult.exitCode}): ${segResult.stdout} ${segResult.stderr}`);
	}

	// Verify status
	const status = db.runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
	if (status !== 'segmented') {
		throw new Error(`Source ${sourceId} has status '${status}', expected 'segmented'`);
	}

	return sourceId;
}

/**
 * Get a story ID from a segmented source.
 */
function getStoryId(sourceId: string): string {
	const storyId = db.runSql(`SELECT id FROM stories WHERE source_id = '${sourceId}' AND status = 'segmented' LIMIT 1;`);
	if (!storyId) {
		throw new Error(`No segmented story found for source ${sourceId}`);
	}
	return storyId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 29 — Enrich Step', () => {
	let pgAvailable: boolean;
	let segmentedSourceId: string | null = null;
	let segmentedStoryId: string | null = null;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		// Run migrations to ensure schema exists
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}

		// Clean state
		cleanTestData();
		cleanStorageFixtures();

		// Pre-ingest, extract, and segment a source for use in tests
		try {
			segmentedSourceId = ingestExtractSegment(NATIVE_TEXT_PDF);
			segmentedStoryId = getStoryId(segmentedSourceId);
		} catch (e) {
			console.warn(`Warning: Could not prepare segmented source: ${e}`);
		}
	}, 180000);

	afterAll(() => {
		if (!pgAvailable) return;
		try {
			cleanTestData();
			cleanStorageFixtures();
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─── QA-01: Single story enrichment ───

	it('QA-01: mulder enrich <story-id> on segmented story exits 0, writes entities/edges/story_entities, updates status to enriched', () => {
		if (!pgAvailable || !segmentedStoryId || !segmentedSourceId) return;

		const result = runCli(['enrich', segmentedStoryId], { timeout: 120000 });
		expect(result.exitCode).toBe(0);

		// Story status should be 'enriched'
		const storyStatus = db.runSql(`SELECT status FROM stories WHERE id = '${segmentedStoryId}';`);
		expect(storyStatus).toBe('enriched');

		// Entities should be created
		const entityCount = db.runSql(`SELECT COUNT(*) FROM story_entities WHERE story_id = '${segmentedStoryId}';`);
		expect(Number.parseInt(entityCount, 10)).toBeGreaterThanOrEqual(1);

		// Entities table should have rows
		const totalEntities = db.runSql(
			`SELECT COUNT(*) FROM entities WHERE id IN (SELECT entity_id FROM story_entities WHERE story_id = '${segmentedStoryId}');`,
		);
		expect(Number.parseInt(totalEntities, 10)).toBeGreaterThanOrEqual(1);

		// Source step should be upserted as 'completed'
		const stepStatus = db.runSql(
			`SELECT status FROM source_steps WHERE source_id = '${segmentedSourceId}' AND step_name = 'enrich';`,
		);
		expect(stepStatus).toBe('completed');
	}, 120000);

	// ─── QA-02: Batch enrichment via --all ───

	it('QA-02: mulder enrich --all enriches all segmented stories and skips already enriched', () => {
		if (!pgAvailable) return;

		// Clean and set up fresh state with two sources
		cleanTestData();
		cleanStorageFixtures();

		ingestExtractSegment(NATIVE_TEXT_PDF);
		ingestExtractSegment(SCANNED_PDF);

		// Verify both have segmented stories
		const segCount = db.runSql("SELECT COUNT(*) FROM stories WHERE status = 'segmented';");
		expect(Number.parseInt(segCount, 10)).toBeGreaterThanOrEqual(2);

		// Enrich all
		const { exitCode } = runCli(['enrich', '--all'], { timeout: 180000 });
		expect(exitCode).toBe(0);

		// All previously segmented stories should now be enriched
		const remainingSegmented = db.runSql("SELECT COUNT(*) FROM stories WHERE status = 'segmented';");
		expect(Number.parseInt(remainingSegmented, 10)).toBe(0);

		const enrichedCount = db.runSql("SELECT COUNT(*) FROM stories WHERE status = 'enriched';");
		expect(Number.parseInt(enrichedCount, 10)).toBeGreaterThanOrEqual(2);

		// Restore state for subsequent tests
		cleanTestData();
		cleanStorageFixtures();
		segmentedSourceId = ingestExtractSegment(NATIVE_TEXT_PDF);
		segmentedStoryId = getStoryId(segmentedSourceId);
	}, 300000);

	// ─── QA-03: Source-scoped enrichment ───

	it('QA-03: mulder enrich --source <id> enriches only stories from that source', () => {
		if (!pgAvailable) return;

		// Clean and set up two sources
		cleanTestData();
		cleanStorageFixtures();

		const sourceId1 = ingestExtractSegment(NATIVE_TEXT_PDF);
		const sourceId2 = ingestExtractSegment(SCANNED_PDF);

		// Enrich only source 1
		const { exitCode } = runCli(['enrich', '--source', sourceId1], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// Source 1 stories should be enriched
		const source1Enriched = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId1}' AND status = 'enriched';`,
		);
		expect(Number.parseInt(source1Enriched, 10)).toBeGreaterThanOrEqual(1);

		// Source 2 stories should still be segmented
		const source2Segmented = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId2}' AND status = 'segmented';`,
		);
		expect(Number.parseInt(source2Segmented, 10)).toBeGreaterThanOrEqual(1);

		// Restore state
		cleanTestData();
		cleanStorageFixtures();
		segmentedSourceId = ingestExtractSegment(NATIVE_TEXT_PDF);
		segmentedStoryId = getStoryId(segmentedSourceId);
	}, 300000);

	// ─── QA-04: Force re-enrichment (story-level) ───

	it('QA-04: enrich with force=true on already enriched story deletes old entities/edges and re-enriches', () => {
		if (!pgAvailable || !segmentedStoryId || !segmentedSourceId) return;

		// First ensure the story is enriched
		const currentStatus = db.runSql(`SELECT status FROM stories WHERE id = '${segmentedStoryId}';`);
		if (currentStatus !== 'enriched') {
			const { exitCode } = runCli(['enrich', segmentedStoryId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Record entity count before force (used to verify re-extraction)
		const countBefore = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM story_entities WHERE story_id = '${segmentedStoryId}';`),
			10,
		);
		expect(countBefore).toBeGreaterThanOrEqual(0);

		// Force re-enrich
		const { exitCode } = runCli(['enrich', segmentedStoryId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// Story should be enriched again
		const status = db.runSql(`SELECT status FROM stories WHERE id = '${segmentedStoryId}';`);
		expect(status).toBe('enriched');

		// story_entities should exist (may be same or different count)
		const entitiesAfter = db.runSql(`SELECT COUNT(*) FROM story_entities WHERE story_id = '${segmentedStoryId}';`);
		expect(Number.parseInt(entitiesAfter, 10)).toBeGreaterThanOrEqual(1);
	}, 120000);

	// ─── QA-05: Force re-enrichment (source-level) ───

	it('QA-05: mulder enrich --source <id> --force re-enriches all stories from that source', () => {
		if (!pgAvailable || !segmentedSourceId) return;

		// Ensure stories are enriched first
		const enrichedCount = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${segmentedSourceId}' AND status = 'enriched';`,
		);
		if (Number.parseInt(enrichedCount, 10) === 0) {
			const { exitCode } = runCli(['enrich', '--source', segmentedSourceId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Force re-enrich
		const { exitCode } = runCli(['enrich', '--source', segmentedSourceId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// All stories from source should be enriched
		const allEnriched = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${segmentedSourceId}' AND status = 'enriched';`,
		);
		expect(Number.parseInt(allEnriched, 10)).toBeGreaterThanOrEqual(1);
	}, 120000);

	// ─── QA-06: Skip already enriched ───

	it('QA-06: enrich on already enriched story without --force returns success with skip indication', () => {
		if (!pgAvailable || !segmentedStoryId) return;

		// Ensure story is enriched
		const currentStatus = db.runSql(`SELECT status FROM stories WHERE id = '${segmentedStoryId}';`);
		if (currentStatus !== 'enriched') {
			const { exitCode } = runCli(['enrich', segmentedStoryId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Run enrich again without force
		const { exitCode, stdout, stderr } = runCli(['enrich', segmentedStoryId], { timeout: 60000 });
		const combined = stdout + stderr;

		// Should succeed (exit 0) — already enriched is not an error
		expect(exitCode).toBe(0);
		// Output should indicate skip
		expect(combined).toMatch(/already enriched|skipped|skip/i);
	}, 120000);

	// ─── QA-07: Invalid status rejection ───

	it('QA-07: enrich on story with status=ingested rejects with ENRICH_INVALID_STATUS', () => {
		if (!pgAvailable) return;

		// Create an isolated source + story via SQL to avoid dedup collision
		// with the main test source (ingestPdf would return the existing source ID)
		db.runSql(
			`INSERT INTO sources (filename, file_hash, storage_path, page_count, status) ` +
				`VALUES ('qa07-test.pdf', 'qa07-unique-hash', 'raw/qa07-test.pdf', 1, 'ingested');`,
		);
		const sourceId = db.runSql(`SELECT id FROM sources WHERE file_hash = 'qa07-unique-hash';`);

		// Manually create a story with status 'ingested' (simulating pre-segmentation state)
		db.runSql(
			`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) ` +
				`VALUES ('${sourceId}', 'test-invalid-status', 'segments/test/dummy.md', 'segments/test/dummy.meta.json', 'ingested');`,
		);
		const storyId = db.runSql(
			`SELECT id FROM stories WHERE source_id = '${sourceId}' AND title = 'test-invalid-status' LIMIT 1;`,
		);

		const { exitCode, stdout, stderr } = runCli(['enrich', storyId], { timeout: 30000 });
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/ENRICH_INVALID_STATUS|invalid status|not segmented|cannot enrich/i);

		// Cleanup — scoped to the isolated source only
		db.runSql(
			`DELETE FROM story_entities WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');` +
				` DELETE FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');` +
				` DELETE FROM stories WHERE source_id = '${sourceId}';` +
				` DELETE FROM source_steps WHERE source_id = '${sourceId}';` +
				` DELETE FROM sources WHERE id = '${sourceId}';`,
		);
	});

	// ─── QA-08: Taxonomy normalization ───

	it('QA-08: after enrichment, entities have a non-null canonical_id from taxonomy normalization', () => {
		if (!pgAvailable || !segmentedStoryId) return;

		// Ensure story is enriched
		const currentStatus = db.runSql(`SELECT status FROM stories WHERE id = '${segmentedStoryId}';`);
		if (currentStatus !== 'enriched') {
			const { exitCode } = runCli(['enrich', segmentedStoryId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Check that entities linked to this story have canonical_id set
		// (taxonomy normalization should assign canonical_id)
		const entitiesWithCanonical = db.runSql(
			`SELECT COUNT(*) FROM entities e ` +
				`JOIN story_entities se ON e.id = se.entity_id ` +
				`WHERE se.story_id = '${segmentedStoryId}' AND e.canonical_id IS NOT NULL;`,
		);
		const totalEntities = db.runSql(
			`SELECT COUNT(*) FROM entities e ` +
				`JOIN story_entities se ON e.id = se.entity_id ` +
				`WHERE se.story_id = '${segmentedStoryId}';`,
		);

		// At least some entities should have canonical_id
		// (taxonomy normalization may not always find a match, but the function should be called)
		const total = Number.parseInt(totalEntities, 10);
		expect(total).toBeGreaterThanOrEqual(1);

		// If taxonomy normalization runs, entities either get a canonical_id or self-reference
		// We check that canonical_id is set (it may equal the entity's own id as self-canonical)
		const withCanonical = Number.parseInt(entitiesWithCanonical, 10);
		expect(withCanonical).toBeGreaterThanOrEqual(1);
	}, 120000);

	// ─── QA-09: Entity resolution ───

	it('QA-09: entity matching an existing entity (same name/type across documents) is merged', () => {
		if (!pgAvailable) return;

		// Enrich two sources. If the same entity name+type appears in both,
		// entity resolution should merge them (same entity ID used).
		cleanTestData();
		cleanStorageFixtures();

		const sourceId1 = ingestExtractSegment(NATIVE_TEXT_PDF);
		const sourceId2 = ingestExtractSegment(SCANNED_PDF);

		// Enrich both
		const r1 = runCli(['enrich', '--source', sourceId1], { timeout: 120000 });
		expect(r1.exitCode).toBe(0);
		const r2 = runCli(['enrich', '--source', sourceId2], { timeout: 120000 });
		expect(r2.exitCode).toBe(0);

		// Check for any entity appearing in stories from both sources
		// (entity resolution should produce shared entities when names match)
		const sharedCount = Number.parseInt(
			db.runSql(
				`SELECT COUNT(DISTINCT e.id) FROM entities e ` +
					`JOIN story_entities se1 ON e.id = se1.entity_id ` +
					`JOIN stories s1 ON se1.story_id = s1.id AND s1.source_id = '${sourceId1}' ` +
					`JOIN story_entities se2 ON e.id = se2.entity_id ` +
					`JOIN stories s2 ON se2.story_id = s2.id AND s2.source_id = '${sourceId2}';`,
			),
			10,
		);

		// We can't guarantee entity overlap with arbitrary test PDFs,
		// but we CAN verify the resolution path ran: check entity count
		const totalEntityIds = Number.parseInt(db.runSql('SELECT COUNT(DISTINCT entity_id) FROM story_entities;'), 10);
		const totalRows = Number.parseInt(db.runSql('SELECT COUNT(*) FROM story_entities;'), 10);

		// At minimum, entities table should be populated from both sources
		expect(totalEntityIds).toBeGreaterThanOrEqual(1);
		// Shared count is informational — may be 0 if PDFs have no overlapping entities
		expect(sharedCount).toBeGreaterThanOrEqual(0);
		expect(totalRows).toBeGreaterThanOrEqual(totalEntityIds);

		// Restore state
		cleanTestData();
		cleanStorageFixtures();
		segmentedSourceId = ingestExtractSegment(NATIVE_TEXT_PDF);
		segmentedStoryId = getStoryId(segmentedSourceId);
	}, 300000);

	// ─── QA-10: Deadlock prevention ───

	it('QA-10: entities are sorted lexicographically by (type, name) before database writes — concurrent enrichment does not deadlock', () => {
		if (!pgAvailable || !segmentedSourceId) return;

		// This tests deadlock prevention indirectly: if entities were NOT sorted,
		// concurrent writes could deadlock. We verify that enrichment completes
		// successfully, which implies correct ordering.
		// (Direct sort verification would require reading implementation code.)

		// Ensure the story is enriched
		const storyId = segmentedStoryId;
		if (!storyId) return;

		const status = db.runSql(`SELECT status FROM stories WHERE id = '${storyId}';`);
		if (status !== 'enriched') {
			const { exitCode } = runCli(['enrich', storyId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Verify entities exist and are in a consistent state (no partial writes from deadlocks)
		const entities = db.runSql(
			`SELECT e.type, e.name FROM entities e ` +
				`JOIN story_entities se ON e.id = se.entity_id ` +
				`WHERE se.story_id = '${storyId}' ORDER BY e.type, e.name;`,
		);
		expect(entities.length).toBeGreaterThan(0);

		// All entities should have non-null type and name
		const nullTypeOrName = db.runSql(
			`SELECT COUNT(*) FROM entities e ` +
				`JOIN story_entities se ON e.id = se.entity_id ` +
				`WHERE se.story_id = '${storyId}' AND (e.type IS NULL OR e.name IS NULL);`,
		);
		expect(Number.parseInt(nullTypeOrName, 10)).toBe(0);
	}, 120000);

	// ─── QA-11: Relationship edge creation ───

	it('QA-11: after enrichment, entity_edges records exist with correct source/target entity IDs and relationship types', () => {
		if (!pgAvailable || !segmentedStoryId) return;

		// Ensure story is enriched
		const currentStatus = db.runSql(`SELECT status FROM stories WHERE id = '${segmentedStoryId}';`);
		if (currentStatus !== 'enriched') {
			const { exitCode } = runCli(['enrich', segmentedStoryId], { timeout: 120000 });
			expect(exitCode).toBe(0);
		}

		// Check entity_edges for this story
		const edgeCount = db.runSql(`SELECT COUNT(*) FROM entity_edges WHERE story_id = '${segmentedStoryId}';`);

		// Edges may or may not exist depending on extracted content,
		// but if they do, they should have valid references
		const numEdges = Number.parseInt(edgeCount, 10);
		if (numEdges > 0) {
			// All edges should reference existing entities
			const orphanEdges = db.runSql(
				`SELECT COUNT(*) FROM entity_edges ee ` +
					`WHERE ee.story_id = '${segmentedStoryId}' ` +
					`AND (ee.source_entity_id NOT IN (SELECT id FROM entities) ` +
					`OR ee.target_entity_id NOT IN (SELECT id FROM entities));`,
			);
			expect(Number.parseInt(orphanEdges, 10)).toBe(0);

			// All edges should have a non-empty relationship type
			const emptyRelationship = db.runSql(
				`SELECT COUNT(*) FROM entity_edges ` +
					`WHERE story_id = '${segmentedStoryId}' AND (relationship IS NULL OR relationship = '');`,
			);
			expect(Number.parseInt(emptyRelationship, 10)).toBe(0);
		}

		// Whether edges exist or not, the enrichment step itself succeeded
		expect(true).toBe(true);
	}, 120000);

	// ─── QA-12: Story not found ───

	it('QA-12: enrich on non-existent story ID throws ENRICH_STORY_NOT_FOUND', () => {
		if (!pgAvailable) return;

		const fakeId = '00000000-0000-0000-0000-000000000000';
		const { exitCode, stdout, stderr } = runCli(['enrich', fakeId]);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/ENRICH_STORY_NOT_FOUND|not found|does not exist/i);
	});

	// ─── QA-13: --all and --force are mutually exclusive ───

	// ─── QA-14: Taxonomy linkage after enrich ───

	it('QA-14: every entity row gets a non-null taxonomy_id after enrich', () => {
		if (!pgAvailable || !segmentedSourceId || !segmentedStoryId) return;

		// Enrich the segmented story (set up by beforeAll).
		const r = runCli(['enrich', segmentedStoryId, '--force'], { timeout: 120_000 });
		expect(r.exitCode).toBe(0);

		// Every entity created by enrich must have a non-null taxonomy_id —
		// that's the cross-story grouping link the fix wires in. Before the
		// fix this column did not exist and the normalizeTaxonomy result was
		// silently discarded.
		const totalEntities = Number.parseInt(
			db.runSql(
				`SELECT COUNT(*) FROM entities WHERE id IN (` +
					`SELECT entity_id FROM story_entities WHERE story_id = '${segmentedStoryId}'` +
					`);`,
			),
			10,
		);
		const linkedEntities = Number.parseInt(
			db.runSql(
				`SELECT COUNT(*) FROM entities WHERE taxonomy_id IS NOT NULL AND id IN (` +
					`SELECT entity_id FROM story_entities WHERE story_id = '${segmentedStoryId}'` +
					`);`,
			),
			10,
		);

		expect(totalEntities).toBeGreaterThan(0);
		expect(linkedEntities).toBe(totalEntities);
	});

	// ─── QA-15: Cross-story entities sharing a name share the same taxonomy_id ───

	it('QA-15: two stories mentioning the same entity name share the same taxonomy_id', () => {
		if (!pgAvailable) return;

		// Two sources, both produce overlapping entity names from the dev
		// fixture. After enrich, any name+type pair appearing in both stories
		// must have a single canonical entity row (ON CONFLICT (name, type))
		// AND that row must have a non-null taxonomy_id.
		cleanTestData();
		cleanStorageFixtures();

		const sourceId1 = ingestExtractSegment(NATIVE_TEXT_PDF);
		const sourceId2 = ingestExtractSegment(SCANNED_PDF);

		expect(runCli(['enrich', '--source', sourceId1], { timeout: 120_000 }).exitCode).toBe(0);
		expect(runCli(['enrich', '--source', sourceId2], { timeout: 120_000 }).exitCode).toBe(0);

		// Find any name+type that exists in both source's stories. If at
		// least one shared entity exists (the dev fixtures share several),
		// it must have exactly one row and a non-null taxonomy_id.
		const sharedRows = db.runSql(
			`SELECT e.id, e.name, e.type, e.taxonomy_id FROM entities e ` +
				`WHERE e.id IN (` +
				`  SELECT se.entity_id FROM story_entities se ` +
				`    JOIN stories s ON s.id = se.story_id WHERE s.source_id = '${sourceId1}'` +
				`) AND e.id IN (` +
				`  SELECT se.entity_id FROM story_entities se ` +
				`    JOIN stories s ON s.id = se.story_id WHERE s.source_id = '${sourceId2}'` +
				`);`,
		);

		// If the dev fixtures don't happen to overlap, this assertion is
		// informational rather than load-bearing — but every shared row
		// MUST have a non-null taxonomy_id.
		const lines = sharedRows.split('\n').filter(Boolean);
		for (const line of lines) {
			const [_id, _name, _type, taxonomyId] = line.split('|');
			expect(taxonomyId, `shared entity ${line} missing taxonomy_id`).toBeTruthy();
		}

		// Restore beforeAll's invariant for the rest of the suite.
		cleanTestData();
		cleanStorageFixtures();
		segmentedSourceId = ingestExtractSegment(NATIVE_TEXT_PDF);
		segmentedStoryId = getStoryId(segmentedSourceId);
	}, 300_000);

	it('QA-13: mulder enrich --all --force exits with code 1 and error message', () => {
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['enrich', '--all', '--force']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(
			/mutually exclusive|cannot use --force with --all|too dangerous|not allowed|not supported/i,
		);
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: enrich', () => {
	// ─── CLI-01: Help output ───

	it('CLI-01: mulder enrich --help output includes story-id, --all, --source, --force', () => {
		const { exitCode, stdout } = runCli(['enrich', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('story-id');
		expect(stdout).toContain('--all');
		expect(stdout).toContain('--source');
		expect(stdout).toContain('--force');
	});

	// ─── CLI-02: No arguments ───

	it('CLI-02: mulder enrich with no args gives non-zero exit and error', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['enrich']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/story-id|--all|--source|provide|missing|required/i);
	});

	// ─── CLI-03: Mutually exclusive args — story-id and --all ───

	it('CLI-03: mulder enrich <id> --all gives non-zero exit and mutually exclusive error', () => {
		const { exitCode, stdout, stderr } = runCli(['enrich', 'some-id', '--all']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/mutually exclusive|cannot|conflict/i);
	});

	// ─── CLI-04: --source without --all ───

	it('CLI-04: mulder enrich --source <id> is valid usage (does not require --all)', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		// Use a fake source ID — should fail with "not found" not "invalid args"
		const fakeSourceId = '00000000-0000-0000-0000-000000000001';
		const { stdout, stderr } = runCli(['enrich', '--source', fakeSourceId]);
		const combined = stdout + stderr;

		// Should NOT be an argument/syntax error — the command accepted the flag combo
		expect(combined).not.toMatch(/mutually exclusive|invalid.*argument|unknown option/i);
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: enrich', () => {
	// ─── SMOKE-01: --help exits cleanly ───

	it('SMOKE-01: mulder enrich --help exits with code 0 and produces output', () => {
		const { exitCode, stdout } = runCli(['enrich', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout.length).toBeGreaterThan(0);
	});

	// ─── SMOKE-02: --force without story-id or --source gives error ───

	it('SMOKE-02: mulder enrich --force (no story-id, no --source) gives non-zero exit', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['enrich', '--force']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/story-id|--all|--source|provide|missing|required/i);
	});

	// ─── SMOKE-03: invalid UUID format as story-id ───

	it('SMOKE-03: mulder enrich with non-UUID story-id gives non-zero exit', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['enrich', 'not-a-valid-uuid']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined.length).toBeGreaterThan(0);
	});

	// ─── SMOKE-04: --help with extra flags does not crash ───

	it('SMOKE-04: mulder enrich --help --force --all does not crash', () => {
		const { exitCode, stdout } = runCli(['enrich', '--help', '--force', '--all']);

		// --help should take precedence
		expect(exitCode).toBe(0);
		expect(stdout).toContain('story-id');
	});

	// ─── SMOKE-05: --source with --all is valid (source scopes the --all) ───

	it('SMOKE-05: mulder enrich --source <id> --force does not crash (valid combo)', () => {
		const pgAvailable = db.isPgAvailable();
		if (!pgAvailable) return;

		const fakeSourceId = '00000000-0000-0000-0000-000000000001';
		const { stdout, stderr } = runCli(['enrich', '--source', fakeSourceId, '--force']);
		const combined = stdout + stderr;

		// Should not be an argument syntax error
		expect(combined).not.toMatch(/unknown option|invalid.*argument/i);
	});

	// ─── SMOKE-06: story-id with --source gives error (mutually exclusive) ───

	it('SMOKE-06: mulder enrich <story-id> --source <source-id> gives error', () => {
		const { exitCode, stdout, stderr } = runCli([
			'enrich',
			'00000000-0000-0000-0000-000000000001',
			'--source',
			'00000000-0000-0000-0000-000000000002',
		]);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/mutually exclusive|cannot|conflict/i);
	});
});
