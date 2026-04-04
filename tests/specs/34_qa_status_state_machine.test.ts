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
 * QA Gate — Status State Machine (QA-2)
 *
 * Runs the pipeline via CLI subprocess on a fixture PDF and verifies
 * database state at each checkpoint.
 *
 * QA-07: Ingest sets correct status
 * QA-08: Extract advances source status
 * QA-09: Segment creates stories
 * QA-10: Enrich updates story not source
 * QA-11: source_steps tracks all completed steps
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

describe('Spec 33 — QA-2: Status State Machine', () => {
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
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}

		// Clean state
		cleanTestData();
		cleanStorageFixtures();
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
	// QA-07: Ingest sets correct status
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-07: mulder ingest creates source with status=ingested and source_step ingest=completed', () => {
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['ingest', NATIVE_TEXT_PDF]);
		expect(exitCode, `Ingest failed: ${stdout} ${stderr}`).toBe(0);

		// Get source ID
		sourceId = runSql(
			`SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;`,
		);
		expect(sourceId).not.toBe('');

		// Verify status
		const status = runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(status).toBe('ingested');

		// Verify source_step
		const stepStatus = runSql(
			`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'ingest';`,
		);
		expect(stepStatus).toBe('completed');
	}, 60000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-08: Extract advances source status
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-08: mulder extract advances source status to extracted, no stories yet', () => {
		if (!pgAvailable || !sourceId) return;

		const { exitCode, stdout, stderr } = runCli(['extract', sourceId], { timeout: 120000 });
		expect(exitCode, `Extract failed: ${stdout} ${stderr}`).toBe(0);

		// Verify status advanced to 'extracted'
		const status = runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(status).toBe('extracted');

		// Verify no stories exist yet (stories are created by segment, not extract)
		const storyCount = Number.parseInt(runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`), 10);
		expect(storyCount).toBe(0);

		// Verify source_step for extract
		const stepStatus = runSql(
			`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'extract';`,
		);
		expect(stepStatus).toBe('completed');
	}, 120000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-09: Segment creates stories
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-09: mulder segment creates stories with status=segmented, source advances to segmented', () => {
		if (!pgAvailable || !sourceId) return;

		ensurePageImages(sourceId);

		const { exitCode, stdout, stderr } = runCli(['segment', sourceId], { timeout: 120000 });
		expect(exitCode, `Segment failed: ${stdout} ${stderr}`).toBe(0);

		// Verify source status
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(sourceStatus).toBe('segmented');

		// Verify stories were created
		const storyCount = Number.parseInt(runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`), 10);
		expect(storyCount).toBeGreaterThanOrEqual(1);

		// Verify all stories have status 'segmented'
		const nonSegmentedCount = Number.parseInt(
			runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}' AND status != 'segmented';`),
			10,
		);
		expect(nonSegmentedCount).toBe(0);

		// Verify source_step for segment
		const stepStatus = runSql(
			`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'segment';`,
		);
		expect(stepStatus).toBe('completed');
	}, 120000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-10: Enrich updates story not source
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-10: mulder enrich --source updates stories to enriched, sources STILL segmented', () => {
		if (!pgAvailable || !sourceId) return;

		const { exitCode, stdout, stderr } = runCli(['enrich', '--source', sourceId], { timeout: 120000 });
		expect(exitCode, `Enrich failed: ${stdout} ${stderr}`).toBe(0);

		// Key assertion: source status REMAINS 'segmented' after enrich
		// This is BY DESIGN — enrich operates on stories, not sources.
		// The pipeline orchestrator (D6, not yet built) advances source status.
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(sourceStatus).toBe('segmented');

		// Verify stories are now 'enriched'
		const enrichedCount = Number.parseInt(
			runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}' AND status = 'enriched';`),
			10,
		);
		expect(enrichedCount).toBeGreaterThanOrEqual(1);

		// Verify no stories are still at 'segmented'
		const segmentedCount = Number.parseInt(
			runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}' AND status = 'segmented';`),
			10,
		);
		expect(segmentedCount).toBe(0);

		// Verify entities were created
		const entityCount = Number.parseInt(
			runSql(
				`SELECT COUNT(DISTINCT e.id) FROM entities e
				 JOIN story_entities se ON e.id = se.entity_id
				 JOIN stories s ON se.story_id = s.id
				 WHERE s.source_id = '${sourceId}';`,
			),
			10,
		);
		expect(entityCount).toBeGreaterThanOrEqual(1);
	}, 120000);

	// ─────────────────────────────────────────────────────────────────────────
	// QA-11: source_steps tracks all completed steps
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-11: source_steps has entries for ingest, extract, segment, enrich — all completed', () => {
		if (!pgAvailable || !sourceId) return;

		const expectedSteps = ['ingest', 'extract', 'segment', 'enrich'];

		for (const stepName of expectedSteps) {
			const stepStatus = runSql(
				`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = '${stepName}';`,
			);
			expect(stepStatus, `source_step '${stepName}' should be 'completed'`).toBe('completed');
		}

		// Verify total step count matches (no extra steps)
		const totalSteps = Number.parseInt(
			runSql(`SELECT COUNT(*) FROM source_steps WHERE source_id = '${sourceId}';`),
			10,
		);
		expect(totalSteps).toBe(expectedSteps.length);
	}, 30000);
});
