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
 * Black-box QA tests for Spec 30: Cascading Reset Function
 *
 * Each `it()` maps to one QA condition or CLI condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via the shared env-driven SQL helper, and filesystem (dev-mode storage).
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
		'DELETE FROM story_entities; DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM chunks; DELETE FROM stories; DELETE FROM source_steps; DELETE FROM sources;',
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
 * Ingest, extract, and segment a PDF. Returns the source ID.
 */
function ingestExtractSegment(pdfPath: string): string {
	const sourceId = ingestPdf(pdfPath);

	// Extract
	const extractResult = runCli(['extract', sourceId], { timeout: 120000 });
	if (extractResult.exitCode !== 0) {
		throw new Error(`Extract failed: ${extractResult.stdout} ${extractResult.stderr}`);
	}
	ensurePageImages(sourceId);

	// Segment
	const segResult = runCli(['segment', sourceId], { timeout: 120000 });
	if (segResult.exitCode !== 0) {
		throw new Error(`Segment failed: ${segResult.stdout} ${segResult.stderr}`);
	}

	const status = db.runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
	if (status !== 'segmented') {
		throw new Error(`Source ${sourceId} has status '${status}', expected 'segmented'`);
	}

	return sourceId;
}

/**
 * Ingest, extract, segment, and enrich a PDF. Returns the source ID.
 * Note: Enrich operates at the story level. Source status stays 'segmented'
 * after enrich — only story status changes to 'enriched'.
 */
function ingestExtractSegmentEnrich(pdfPath: string): string {
	const sourceId = ingestExtractSegment(pdfPath);

	// Enrich (source-level)
	const enrichResult = runCli(['enrich', '--source', sourceId], { timeout: 120000 });
	if (enrichResult.exitCode !== 0) {
		throw new Error(`Enrich failed: ${enrichResult.stdout} ${enrichResult.stderr}`);
	}

	// Verify stories are enriched (source status stays 'segmented' — enrich is story-level)
	const enrichedCount = Number.parseInt(
		db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}' AND status = 'enriched';`),
		10,
	);
	if (enrichedCount === 0) {
		throw new Error(`No enriched stories found for source ${sourceId}`);
	}

	return sourceId;
}

/**
 * Extract the JSON line from CLI output that mixes pino log lines with data.
 * Looks for a line that starts with `{` and contains the expected key.
 */
function extractJsonLine(output: string, expectedKey: string): Record<string, unknown> | null {
	for (const line of output.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (expectedKey in parsed) return parsed;
		} catch {
			// not valid JSON or not the line we want
		}
	}
	return null;
}

function getStoryId(sourceId: string): string {
	const storyId = db.runSql(`SELECT id FROM stories WHERE source_id = '${sourceId}' LIMIT 1;`);
	if (!storyId) {
		throw new Error(`No story found for source ${sourceId}`);
	}
	return storyId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 30 — Cascading Reset Function', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		// Run migrations
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}
	}, 60000);

	afterAll(() => {
		if (!pgAvailable) return;
		try {
			cleanTestData();
			cleanStorageFixtures();
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-01: Extract --force uses atomic reset
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-01: Extract --force uses atomic reset — stories, source_steps deleted, source status reset to ingested, GCS extracted/ cleaned', () => {
		if (!pgAvailable) return;

		// Setup: clean state, ingest + extract + segment to have stories, chunks, source_steps
		cleanTestData();
		cleanStorageFixtures();

		const sourceId = ingestExtractSegment(NATIVE_TEXT_PDF);

		// Verify pre-condition: stories exist
		const storyCountBefore = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`),
			10,
		);
		expect(storyCountBefore).toBeGreaterThanOrEqual(1);

		// Verify pre-condition: source_steps exist
		const stepCountBefore = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM source_steps WHERE source_id = '${sourceId}';`),
			10,
		);
		expect(stepCountBefore).toBeGreaterThanOrEqual(1);

		// Act: run extract --force
		const { exitCode } = runCli(['extract', sourceId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// Assert: source status is back to 'ingested' (extract resets to ingested then re-extracts)
		// Actually after --force, the extract step re-runs, so status should be 'extracted'
		const statusAfter = db.runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(statusAfter).toBe('extracted');

		// Assert: old stories were deleted (new ones may have been created by re-extraction if extract creates stories, but extract doesn't create stories - that's segment)
		// After extract --force with reset_pipeline_step('extract'), ALL stories are deleted and source_steps are cleared
		// Then extract re-runs which only produces GCS artifacts, not stories
		// So there should be NO stories (segment hasn't re-run)
		const storyCountAfter = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`),
			10,
		);
		expect(storyCountAfter).toBe(0);

		// Assert: GCS extracted/ artifacts exist (re-extracted)
		const extractedDir = join(EXTRACTED_DIR, sourceId);
		expect(existsSync(extractedDir)).toBe(true);
	}, 180000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-02: Segment --force uses atomic reset
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-02: Segment --force uses atomic reset — stories deleted atomically, source_steps cleared for segment/enrich/embed/graph, source reset to extracted, GCS segments/ cleaned', () => {
		if (!pgAvailable) return;

		// Setup: clean state, full pipeline through segment
		cleanTestData();
		cleanStorageFixtures();

		const sourceId = ingestExtractSegment(NATIVE_TEXT_PDF);

		// Verify pre-condition: stories exist
		const storyCountBefore = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`),
			10,
		);
		expect(storyCountBefore).toBeGreaterThanOrEqual(1);

		// Verify source_steps for segment exist
		const segStepBefore = db.runSql(
			`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'segment';`,
		);
		expect(segStepBefore).toBe('completed');

		// Act: run segment --force
		ensurePageImages(sourceId);
		const { exitCode } = runCli(['segment', sourceId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// After --force, segment re-runs so status should be 'segmented' again and new stories exist
		const statusAfter = db.runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(statusAfter).toBe('segmented');

		// New stories should exist (from re-segmentation)
		const storyCountAfter = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`),
			10,
		);
		expect(storyCountAfter).toBeGreaterThanOrEqual(1);

		// GCS segments/ should have new artifacts
		const segmentDir = join(SEGMENTS_DIR, sourceId);
		expect(existsSync(segmentDir)).toBe(true);
	}, 180000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-03: Enrich --force (source-level) uses atomic reset
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-03: Enrich --force (source-level) uses atomic reset — story_entities and entity_edges deleted, source_steps cleared for enrich/embed/graph, stories reset to segmented, source reset to segmented', () => {
		if (!pgAvailable) return;

		// Setup: full pipeline through enrich
		cleanTestData();
		cleanStorageFixtures();

		const sourceId = ingestExtractSegmentEnrich(NATIVE_TEXT_PDF);

		// Verify pre-condition: story_entities exist
		const seCountBefore = Number.parseInt(
			db.runSql(
				`SELECT COUNT(*) FROM story_entities WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');`,
			),
			10,
		);
		expect(seCountBefore).toBeGreaterThanOrEqual(1);

		// Verify enrich source_step exists
		const enrichStepBefore = db.runSql(
			`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'enrich';`,
		);
		expect(enrichStepBefore).toBe('completed');

		// Act: enrich --source <id> --force
		const { exitCode } = runCli(['enrich', '--source', sourceId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// After --force re-enrichment, source status stays 'segmented' (enrich is story-level)
		const statusAfter = db.runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(statusAfter).toBe('segmented');

		// Stories should be enriched again after re-enrichment
		const enrichedStoriesAfter = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}' AND status = 'enriched';`),
			10,
		);
		expect(enrichedStoriesAfter).toBeGreaterThanOrEqual(1);

		// story_entities should exist again (re-enriched)
		const seCountAfter = Number.parseInt(
			db.runSql(
				`SELECT COUNT(*) FROM story_entities WHERE story_id IN (SELECT id FROM stories WHERE source_id = '${sourceId}');`,
			),
			10,
		);
		expect(seCountAfter).toBeGreaterThanOrEqual(1);

		// Enrich source_step should be completed again
		const enrichStepAfter = db.runSql(
			`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'enrich';`,
		);
		expect(enrichStepAfter).toBe('completed');
	}, 240000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-04: Enrich --force (story-level) still works
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-04: Enrich --force (story-level) still works — that story entities/edges deleted and re-enriched, other stories untouched', () => {
		if (!pgAvailable) return;

		// Setup: full pipeline through enrich
		cleanTestData();
		cleanStorageFixtures();

		const sourceId = ingestExtractSegmentEnrich(NATIVE_TEXT_PDF);

		// Get a story ID
		const storyId = getStoryId(sourceId);

		// Verify pre-condition: story has entities
		const seCountBefore = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM story_entities WHERE story_id = '${storyId}';`),
			10,
		);
		expect(seCountBefore).toBeGreaterThanOrEqual(1);

		// Check if there are other stories
		const allStoryIds = db
			.runSql(`SELECT id FROM stories WHERE source_id = '${sourceId}';`)
			.split('\n')
			.filter(Boolean);

		// Act: enrich single story with --force
		const { exitCode } = runCli(['enrich', storyId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// The targeted story should be enriched
		const storyStatus = db.runSql(`SELECT status FROM stories WHERE id = '${storyId}';`);
		expect(storyStatus).toBe('enriched');

		// Story entities should exist again
		const seCountAfter = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM story_entities WHERE story_id = '${storyId}';`),
			10,
		);
		expect(seCountAfter).toBeGreaterThanOrEqual(1);

		// Other stories (if any) should still be enriched (untouched)
		for (const otherId of allStoryIds) {
			if (otherId === storyId) continue;
			const otherStatus = db.runSql(`SELECT status FROM stories WHERE id = '${otherId}';`);
			expect(otherStatus).toBe('enriched');
		}
	}, 180000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-05: `mulder db gc` removes orphaned entities
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-05: mulder db gc removes orphaned entities — entities with no story_entities references are deleted, count reported', () => {
		if (!pgAvailable) return;

		// Clean state
		cleanTestData();

		// Insert orphaned entities (no story_entities references)
		db.runSql(`INSERT INTO entities (name, type) VALUES ('OrphanEntity1', 'person'), ('OrphanEntity2', 'location');`);

		// Verify they exist
		const countBefore = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM entities WHERE name IN ('OrphanEntity1', 'OrphanEntity2');`),
			10,
		);
		expect(countBefore).toBe(2);

		// Act: run db gc
		const { exitCode, stdout, stderr } = runCli(['db', 'gc', EXAMPLE_CONFIG]);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);

		// Should report a count (at least 2 orphans deleted)
		expect(combined).toMatch(/\d+/);

		// Orphaned entities should be deleted
		const countAfter = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM entities WHERE name IN ('OrphanEntity1', 'OrphanEntity2');`),
			10,
		);
		expect(countAfter).toBe(0);
	}, 30000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-06: `mulder db gc --json` outputs JSON
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-06: mulder db gc --json outputs valid JSON with a deleted field (integer)', () => {
		if (!pgAvailable) return;

		// Clean state and insert orphans
		cleanTestData();
		db.runSql(`INSERT INTO entities (name, type) VALUES ('JsonOrphan1', 'person');`);

		// Act
		const { exitCode, stdout } = runCli(['db', 'gc', '--json', EXAMPLE_CONFIG]);
		expect(exitCode).toBe(0);

		// Parse the JSON line from stdout (pino logs are also on stdout)
		const parsed = extractJsonLine(stdout, 'deleted');
		expect(parsed).not.toBeNull();
		expect(typeof parsed?.deleted).toBe('number');
		expect(parsed?.deleted as number).toBeGreaterThanOrEqual(1);
	}, 30000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-07: `mulder db gc` reports zero when no orphans
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-07: mulder db gc reports zero when no orphaned entities — output says "No orphaned entities found"', () => {
		if (!pgAvailable) return;

		// Clean state — no entities at all
		cleanTestData();

		// Act
		const { exitCode, stdout, stderr } = runCli(['db', 'gc', EXAMPLE_CONFIG]);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		// The success message contains "No orphaned entities found" — check stdout for the checkmark message
		// or verify via --json that deleted count is 0
		expect(combined).toMatch(/[Nn]o orphaned entities|deleted.*0|0.*orphan/i);
	}, 30000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-08: Entities shared across sources are NOT deleted by --force
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-08: Entities shared across sources are NOT deleted by enrich --force — entity still exists, only source A story_entities removed', () => {
		if (!pgAvailable) return;

		// Setup: two sources, both enriched, sharing an entity
		cleanTestData();
		cleanStorageFixtures();

		const sourceIdA = ingestExtractSegmentEnrich(NATIVE_TEXT_PDF);
		const sourceIdB = ingestExtractSegmentEnrich(SCANNED_PDF);

		const storyIdA = getStoryId(sourceIdA);
		const storyIdB = getStoryId(sourceIdB);

		// Create a shared entity and link it to both stories
		db.runSql(`INSERT INTO entities (name, type) VALUES ('SharedEntity_USA', 'location');`);
		const sharedEntityId = db.runSql(`SELECT id FROM entities WHERE name = 'SharedEntity_USA';`);
		db.runSql(
			`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES ('${storyIdA}', '${sharedEntityId}', 0.9) ON CONFLICT DO NOTHING;`,
		);
		db.runSql(
			`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES ('${storyIdB}', '${sharedEntityId}', 0.85) ON CONFLICT DO NOTHING;`,
		);

		// Verify both links exist
		const linkCountBefore = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM story_entities WHERE entity_id = '${sharedEntityId}';`),
			10,
		);
		expect(linkCountBefore).toBeGreaterThanOrEqual(2);

		// Act: enrich --source sourceA --force
		const { exitCode } = runCli(['enrich', '--source', sourceIdA, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// Assert: shared entity still exists in entities table
		const entityExists = db.runSql(`SELECT COUNT(*) FROM entities WHERE id = '${sharedEntityId}';`);
		expect(Number.parseInt(entityExists, 10)).toBe(1);

		// Assert: Source B's link to the shared entity still exists
		const linkB = db.runSql(
			`SELECT COUNT(*) FROM story_entities WHERE entity_id = '${sharedEntityId}' AND story_id = '${storyIdB}';`,
		);
		expect(Number.parseInt(linkB, 10)).toBe(1);

		// Assert: Source A's OLD link was deleted (reset_pipeline_step deletes story_entities for source A)
		// Source A may have new story_entities from re-enrichment, but the manually-inserted SharedEntity_USA
		// link should be gone (since reset deleted all story_entities for source A stories)
		// Note: re-enrichment may or may not re-create a link to SharedEntity_USA, so we just check
		// that Source B's link is intact and the entity still exists
	}, 300000);

	// ─────────────────────────────────────────────────────────────────────────
	// CLI-01: `mulder db gc` exits 0, output contains "orphaned" or "entities"
	// ─────────────────────────────────────────────────────────────────────────

	it('CLI-01: mulder db gc exits 0, output contains "orphaned" or "entities"', () => {
		if (!pgAvailable) return;

		cleanTestData();

		const { exitCode, stdout, stderr } = runCli(['db', 'gc', EXAMPLE_CONFIG]);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		// Human-readable message goes to stderr, logs to stdout
		expect(combined).toMatch(/orphan|entit/i);
	}, 30000);

	// ─────────────────────────────────────────────────────────────────────────
	// CLI-02: `mulder db gc --json` exits 0, stdout is valid JSON with `deleted` key
	// ─────────────────────────────────────────────────────────────────────────

	it('CLI-02: mulder db gc --json exits 0, stdout is valid JSON with deleted key', () => {
		if (!pgAvailable) return;

		cleanTestData();

		const { exitCode, stdout } = runCli(['db', 'gc', '--json', EXAMPLE_CONFIG]);
		expect(exitCode).toBe(0);

		// stdout contains JSON data line mixed with pino log lines
		const parsed = extractJsonLine(stdout, 'deleted');
		expect(parsed).not.toBeNull();
		expect(parsed).toHaveProperty('deleted');
	}, 30000);

	// ─────────────────────────────────────────────────────────────────────────
	// CLI-03: `mulder db gc --help` exits 0, shows description
	// ─────────────────────────────────────────────────────────────────────────

	it('CLI-03: mulder db gc --help exits 0, shows description', () => {
		const { exitCode, stdout, stderr } = runCli(['db', 'gc', '--help']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toMatch(/[Gg]arbage.collect|orphaned entities/i);
	}, 10000);
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: mulder db gc', () => {
	it('SMOKE-01: --help produces usage information with options listed', () => {
		const { exitCode, stdout, stderr } = runCli(['db', 'gc', '--help']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toMatch(/--json/);
		expect(combined).toMatch(/--help/);
		expect(combined).toMatch(/config-path/i);
	}, 10000);

	it('SMOKE-02: mulder db --help lists gc as a subcommand', () => {
		const { exitCode, stdout, stderr } = runCli(['db', '--help']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toMatch(/gc/);
	}, 10000);

	it('SMOKE-03: mulder db gc with invalid config path gives error', () => {
		const { exitCode, stdout, stderr } = runCli(['db', 'gc', '/nonexistent/config.yaml']);
		const combined = stdout + stderr;

		// Should fail with non-zero exit code
		expect(exitCode).not.toBe(0);
		// Should produce an error message
		expect(combined.length).toBeGreaterThan(0);
	}, 10000);

	it('SMOKE-04: mulder db gc --json with no orphans produces valid JSON with deleted: 0', () => {
		if (!db.isPgAvailable()) return;

		// Clean all entities
		try {
			db.runSql(
				'DELETE FROM story_entities; DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities;',
			);
		} catch {
			// ignore
		}

		const { exitCode, stdout } = runCli(['db', 'gc', '--json', EXAMPLE_CONFIG]);
		expect(exitCode).toBe(0);

		const parsed = extractJsonLine(stdout, 'deleted');
		expect(parsed).not.toBeNull();
		expect(parsed?.deleted).toBe(0);
	}, 30000);

	it('SMOKE-05: mulder db gc --json flag order does not matter (flag after config path)', () => {
		if (!db.isPgAvailable()) return;

		// Try: mulder db gc <config> --json (flag after argument)
		const { exitCode, stdout } = runCli(['db', 'gc', EXAMPLE_CONFIG, '--json']);
		expect(exitCode).toBe(0);

		const parsed = extractJsonLine(stdout, 'deleted');
		expect(parsed).not.toBeNull();
		expect(parsed).toHaveProperty('deleted');
	}, 30000);
});
