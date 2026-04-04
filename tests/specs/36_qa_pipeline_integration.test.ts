import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = resolve(ROOT, '.local/storage/extracted');
const SEGMENTS_DIR = resolve(ROOT, '.local/storage/segments');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

/**
 * QA Gate — Cross-Step Pipeline Integration (QA-4)
 *
 * End-to-end pipeline run on fixture data. Steps 1-4 use CLI subprocess.
 * Verifies FK integrity, retrieval join path, and idempotent re-enrich.
 *
 * QA-18: Pipeline produces FK-consistent state
 * QA-19: Retrieval join path works
 * QA-20: Idempotent re-enrich
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
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runSql(sql: string): string {
	try {
		const result = execFileSync(
			'docker',
			['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
			{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		return (result ?? '').trim();
	} catch (error: unknown) {
		const err = error as { stderr?: string; status?: number };
		throw new Error(`psql failed (exit ${err.status}): ${err.stderr}`);
	}
}

function isPgAvailable(): boolean {
	try {
		execFileSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}

function cleanTestData(): void {
	runSql(
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

function ensurePageImages(sourceId: string): void {
	const pagesDir = join(EXTRACTED_DIR, sourceId, 'pages');
	if (!existsSync(pagesDir)) {
		const layoutPath = join(EXTRACTED_DIR, sourceId, 'layout.json');
		if (existsSync(layoutPath)) {
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
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 33 — QA-4: Cross-Step Pipeline Integration', () => {
	let pgAvailable: boolean;
	let sourceId: string;

	beforeAll(() => {
		pgAvailable = isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: PostgreSQL container not available. Start with:\n' +
					'  docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
			return;
		}

		// Run migrations
		const migrateResult = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (migrateResult.exitCode !== 0) {
			throw new Error(`Migration failed: ${migrateResult.stdout} ${migrateResult.stderr}`);
		}

		// Clean state
		cleanTestData();
		cleanStorageFixtures();

		// Run full pipeline: ingest → extract → segment → enrich
		const ingestResult = runCli(['ingest', NATIVE_TEXT_PDF]);
		if (ingestResult.exitCode !== 0) {
			throw new Error(`Ingest failed: ${ingestResult.stdout} ${ingestResult.stderr}`);
		}

		sourceId = runSql(
			`SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;`,
		);
		if (!sourceId) throw new Error('No source found after ingest');

		const extractResult = runCli(['extract', sourceId], { timeout: 120000 });
		if (extractResult.exitCode !== 0) {
			throw new Error(`Extract failed: ${extractResult.stdout} ${extractResult.stderr}`);
		}

		ensurePageImages(sourceId);

		const segResult = runCli(['segment', sourceId], { timeout: 120000 });
		if (segResult.exitCode !== 0) {
			throw new Error(`Segment failed: ${segResult.stdout} ${segResult.stderr}`);
		}

		const enrichResult = runCli(['enrich', '--source', sourceId], { timeout: 120000 });
		if (enrichResult.exitCode !== 0) {
			throw new Error(`Enrich failed: ${enrichResult.stdout} ${enrichResult.stderr}`);
		}

		// Insert synthetic chunks to simulate embed step (D4 not built yet).
		// This enables the join-path test without requiring an actual embed step.
		const storyIds = runSql(`SELECT id FROM stories WHERE source_id = '${sourceId}';`).split('\n').filter(Boolean);

		for (const sid of storyIds) {
			runSql(
				`INSERT INTO chunks (story_id, content, chunk_index)
				 VALUES ('${sid}', 'Synthetic chunk for integration test', 0)
				 ON CONFLICT DO NOTHING;`,
			);
		}
	}, 300000);

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
	// QA-18: Pipeline produces FK-consistent state
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-18: FK integrity — no orphaned chunks, story_entities, or entity_edges (verified by JOINs)', () => {
		if (!pgAvailable || !sourceId) return;

		// Every chunk has a valid story_id
		const orphanedChunks = Number.parseInt(
			runSql(
				`SELECT COUNT(*) FROM chunks c
				 LEFT JOIN stories s ON c.story_id = s.id
				 WHERE s.id IS NULL;`,
			),
			10,
		);
		expect(orphanedChunks, 'No orphaned chunks (story_id FK intact)').toBe(0);

		// Every story_entity links to valid story AND entity
		const orphanedSE = Number.parseInt(
			runSql(
				`SELECT COUNT(*) FROM story_entities se
				 LEFT JOIN stories s ON se.story_id = s.id
				 LEFT JOIN entities e ON se.entity_id = e.id
				 WHERE s.id IS NULL OR e.id IS NULL;`,
			),
			10,
		);
		expect(orphanedSE, 'No orphaned story_entities').toBe(0);

		// Every entity_edge with a story_id links to a valid story
		const orphanedEdges = Number.parseInt(
			runSql(
				`SELECT COUNT(*) FROM entity_edges ee
				 LEFT JOIN stories s ON ee.story_id = s.id
				 WHERE ee.story_id IS NOT NULL AND s.id IS NULL;`,
			),
			10,
		);
		expect(orphanedEdges, 'No orphaned entity_edges').toBe(0);

		// Verify stories actually belong to this source
		const storyCount = Number.parseInt(runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`), 10);
		expect(storyCount).toBeGreaterThanOrEqual(1);
	}, 30000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-19: Retrieval join path works
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-19: Cross-table retrieval JOIN returns chunk content + story title + entity name', () => {
		if (!pgAvailable || !sourceId) return;

		// This is the exact join path D4+ retrieval will use
		const result = runSql(
			`SELECT c.id, c.content, s.title, e.name
			 FROM chunks c
			 JOIN stories s ON c.story_id = s.id
			 JOIN story_entities se ON s.id = se.story_id
			 JOIN entities e ON se.entity_id = e.id
			 WHERE s.source_id = '${sourceId}'
			 LIMIT 5;`,
		);

		// Must return at least one row
		expect(result, 'Retrieval join path must return rows').not.toBe('');

		// Parse each row and verify all four columns are present
		const rows = result.split('\n').filter(Boolean);
		expect(rows.length).toBeGreaterThanOrEqual(1);

		for (const row of rows) {
			const cols = row.split('|');
			expect(cols.length).toBeGreaterThanOrEqual(4);
			expect(cols[0], 'chunk.id present').not.toBe('');
			expect(cols[1], 'chunk.content present').not.toBe('');
			expect(cols[2], 'story.title present').not.toBe('');
			expect(cols[3], 'entity.name present').not.toBe('');
		}
	}, 30000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-20: Idempotent re-enrich
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-20: Running enrich --source twice does not create duplicate entities (upsert)', () => {
		if (!pgAvailable || !sourceId) return;

		// Count entities before re-enrich
		const entityCountBefore = Number.parseInt(
			runSql(
				`SELECT COUNT(DISTINCT e.id) FROM entities e
				 JOIN story_entities se ON e.id = se.entity_id
				 JOIN stories s ON se.story_id = s.id
				 WHERE s.source_id = '${sourceId}';`,
			),
			10,
		);
		expect(entityCountBefore).toBeGreaterThanOrEqual(1);

		// Count total story_entities before
		const seBefore = Number.parseInt(
			runSql(
				`SELECT COUNT(*) FROM story_entities se
				 JOIN stories s ON se.story_id = s.id
				 WHERE s.source_id = '${sourceId}';`,
			),
			10,
		);

		// Re-enrich the same source (without --force, should be idempotent via upserts)
		// Note: enrich --source without --force may skip if already enriched.
		// We use --force to ensure it actually re-runs, which tests upsert correctness.
		const { exitCode } = runCli(['enrich', '--source', sourceId, '--force'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// Count entities after re-enrich
		const entityCountAfter = Number.parseInt(
			runSql(
				`SELECT COUNT(DISTINCT e.id) FROM entities e
				 JOIN story_entities se ON e.id = se.entity_id
				 JOIN stories s ON se.story_id = s.id
				 WHERE s.source_id = '${sourceId}';`,
			),
			10,
		);

		// Entity count should be the same (upsert, no duplicates)
		expect(entityCountAfter).toBe(entityCountBefore);

		// story_entities count should also be same or very close
		const seAfter = Number.parseInt(
			runSql(
				`SELECT COUNT(*) FROM story_entities se
				 JOIN stories s ON se.story_id = s.id
				 WHERE s.source_id = '${sourceId}';`,
			),
			10,
		);
		expect(seAfter).toBe(seBefore);
	}, 180000);
});
