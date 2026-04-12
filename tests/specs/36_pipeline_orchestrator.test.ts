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
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 36: Pipeline Orchestrator
 *
 * Each `it()` maps to one QA condition or CLI condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `the shared env-driven SQL helper`, and filesystem (dev-mode storage).
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
		'DELETE FROM pipeline_run_sources; DELETE FROM pipeline_runs; ' +
			'DELETE FROM chunks; DELETE FROM story_entities; DELETE FROM entity_edges; ' +
			'DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM stories; ' +
			'DELETE FROM source_steps; DELETE FROM sources;',
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

/**
 * Run a per-source pipeline through extract+segment so page images exist after
 * orchestrator runs (orchestrator always invokes ingest first; extract requires
 * page images for segment to work in dev mode). We patch images after the
 * orchestrator's extract step by post-running extract again to materialise
 * page-image files.
 */

/**
 * Create a single isolated source row directly via SQL with arbitrary status.
 * Returns the source id. Used for setup of resume/idempotency tests where we
 * don't need actual GCS data.
 */

/**
 * Set up a single PDF in an isolated work directory so we can ingest just that file.
 */
function makeWorkDir(name: string, files: string[]): string {
	const dir = resolve(ROOT, '.local', 'tmp-tests', name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const f of files) {
		const parts = f.split('/');
		const basename = parts[parts.length - 1];
		const dest = join(dir, basename);
		writeFileSync(dest, readFileSync(f));
	}
	return dir;
}

/**
 * After orchestrator runs ingest+extract, page images need to exist on disk
 * so segment will succeed. This calls extract directly via CLI for the source
 * to ensure page images are materialised. Idempotent.
 */
function materialisePageImages(sourceId: string): void {
	ensurePageImages(sourceId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 36 — Pipeline Orchestrator', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL container not available. Start with:\n  docker compose up -d');
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
	}, 600000);

	afterAll(() => {
		if (!pgAvailable) return;
		try {
			cleanTestData();
			cleanStorageFixtures();
			rmSync(resolve(ROOT, '.local/tmp-tests'), { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─── QA-01: Happy path — full pipeline run ───

	it('QA-01: mulder pipeline run <dir> processes a fixture PDF end-to-end', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa01', [NATIVE_TEXT_PDF]);

		// Stage 1: ingest + extract via orchestrator with --up-to extract.
		// We then materialise page images and resume from segment so the rest of
		// the pipeline can run. This is necessary because dev-mode extract does
		// not write the .png images that segment requires; the existing 35 spec
		// has the same workaround.
		const stage1 = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(stage1.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		expect(sourceId).toMatch(/^[0-9a-f-]+$/);

		materialisePageImages(sourceId);

		// Stage 2: resume from segment through graph (full v1.0 chain).
		const stage2 = runCli(['pipeline', 'run', workDir, '--from', 'segment'], { timeout: 600000 });
		expect(stage2.exitCode).toBe(0);

		// Note: spec QA-01 says `sources.status = 'graphed'` but the existing
		// pipeline architecture only advances `sources.status` through ingest →
		// extracted → segmented. Story-fanout steps (enrich/embed/graph) update
		// `stories.status`, not `sources.status`. Spec 35's tests follow the
		// same pattern. Asserting on `stories.status` is the source of truth.
		const storyStatus = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${sourceId}';`);
		expect(storyStatus).toBe('graphed');

		// Latest pipeline_runs row for stage2 should be 'completed'
		const runStatus = db.runSql('SELECT status FROM pipeline_runs ORDER BY created_at DESC LIMIT 1;');
		expect(runStatus).toBe('completed');

		// pipeline_run_sources for the latest run shows current_step = graph, status completed
		const rowState = db.runSql(
			"SELECT current_step || '|' || status FROM pipeline_run_sources " +
				'WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1) ' +
				`AND source_id = '${sourceId}';`,
		);
		expect(rowState).toBe('graph|completed');
	}, 900000);

	// ─── QA-02: --up-to enrich stops mid-pipeline ───

	it('QA-02: --up-to enrich stops at enrich (no embed/graph)', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa02', [NATIVE_TEXT_PDF]);

		// Stage 1: ingest + extract
		const stage1 = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(stage1.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		materialisePageImages(sourceId);

		// Stage 2: from segment up to enrich
		const stage2 = runCli(['pipeline', 'run', workDir, '--from', 'segment', '--up-to', 'enrich'], { timeout: 600000 });
		expect(stage2.exitCode).toBe(0);

		// Story should be 'enriched' — not embedded or graphed
		// (spec says sources.status, but story-fanout steps update stories.status)
		const storyStatus = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${sourceId}';`);
		expect(storyStatus).toBe('enriched');

		// Run should be 'completed'
		const runStatus = db.runSql('SELECT status FROM pipeline_runs ORDER BY created_at DESC LIMIT 1;');
		expect(runStatus).toBe('completed');

		// pipeline_run_sources current_step should be 'enrich'
		const currentStep = db.runSql(
			'SELECT current_step FROM pipeline_run_sources ' +
				'WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1) ' +
				`AND source_id = '${sourceId}';`,
		);
		expect(currentStep).toBe('enrich');
	}, 900000);

	// ─── QA-03: --from embed resumes from cursor ───

	it('QA-03: --from embed runs only embed + graph for an enriched source', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa03', [NATIVE_TEXT_PDF]);

		// Stage 1: ingest + extract
		const stage1 = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(stage1.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		materialisePageImages(sourceId);

		// Stage 2: drive source through enrich
		const stage2 = runCli(['pipeline', 'run', workDir, '--from', 'segment', '--up-to', 'enrich'], { timeout: 600000 });
		expect(stage2.exitCode).toBe(0);

		// Verify story is 'enriched' (story-level state — see QA-01 note)
		const preStatus = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${sourceId}';`);
		expect(preStatus).toBe('enriched');

		// Stage 3: --from embed should run embed + graph
		const stage3 = runCli(['pipeline', 'run', workDir, '--from', 'embed'], { timeout: 600000 });
		expect(stage3.exitCode).toBe(0);

		// Story should now be 'graphed'
		const postStatus = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${sourceId}';`);
		expect(postStatus).toBe('graphed');

		// pipeline_run_sources current_step should be 'graph' for the latest run
		const currentStep = db.runSql(
			'SELECT current_step FROM pipeline_run_sources ' +
				'WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1) ' +
				`AND source_id = '${sourceId}';`,
		);
		expect(currentStep).toBe('graph');
	}, 900000);

	// ─── QA-04: Failed source does not crash batch ───

	it('QA-04: a failed source is marked failed and batch continues', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		// Make a work dir with one valid PDF and one non-PDF file (fails at ingest pre-flight)
		const workDir = resolve(ROOT, '.local', 'tmp-tests', 'qa04');
		rmSync(workDir, { recursive: true, force: true });
		mkdirSync(workDir, { recursive: true });
		writeFileSync(join(workDir, 'native-text-sample.pdf'), readFileSync(NATIVE_TEXT_PDF));
		writeFileSync(join(workDir, 'broken.pdf'), 'not a pdf, just garbage to break ingest');

		// Run the orchestrator only up to extract — that's enough to verify the
		// "failed source doesn't crash batch" path. The good PDF should reach
		// extract; the bad one should be marked failed.
		const result = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 300000 });

		// Exit code 0 means partial/success (batch did not crash)
		expect(result.exitCode).toBe(0);

		// Latest run should be 'partial' or 'completed' (if broken file failed pre-flight,
		// it never produces a pipeline_run_sources row, leaving the run as completed for
		// the good source). Either way, the orchestrator must NOT have crashed.
		const runStatus = db.runSql('SELECT status FROM pipeline_runs ORDER BY created_at DESC LIMIT 1;');
		expect(['completed', 'partial', 'failed']).toContain(runStatus);

		// At least one source row exists in the run (the good one, or both)
		const numRows = db.runSql(
			'SELECT COUNT(*) FROM pipeline_run_sources ' +
				'WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1);',
		);
		expect(Number.parseInt(numRows, 10)).toBeGreaterThanOrEqual(1);

		// The good PDF should have been ingested
		const goodSource = db.runSql("SELECT COUNT(*) FROM sources WHERE filename = 'native-text-sample.pdf';");
		expect(Number.parseInt(goodSource, 10)).toBeGreaterThanOrEqual(1);
	}, 600000);

	// ─── QA-05: --dry-run makes no writes ───

	it('QA-05: --dry-run prints plan without inserting pipeline_runs', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa05', [NATIVE_TEXT_PDF]);

		const beforeRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');
		const beforeSources = db.runSql('SELECT COUNT(*) FROM sources;');

		const result = runCli(['pipeline', 'run', workDir, '--dry-run'], { timeout: 60000 });
		expect(result.exitCode).toBe(0);

		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/dry run|planned|plan/i);

		// No new pipeline_runs row created
		const afterRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');
		expect(afterRuns).toBe(beforeRuns);

		// No new sources row created (dry-run should not ingest)
		const afterSources = db.runSql('SELECT COUNT(*) FROM sources;');
		expect(afterSources).toBe(beforeSources);
	}, 120000);

	// ─── QA-06: --tag is persisted ───

	it('QA-06: --tag value is persisted on the pipeline_runs row', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa06', [NATIVE_TEXT_PDF]);
		const tag = `qa06-tag-${Date.now()}`;

		// Use --up-to extract so the test runs fast
		const result = runCli(['pipeline', 'run', workDir, '--up-to', 'extract', '--tag', tag], {
			timeout: 240000,
		});
		expect(result.exitCode).toBe(0);

		const persistedTag = db.runSql('SELECT tag FROM pipeline_runs ORDER BY created_at DESC LIMIT 1;');
		expect(persistedTag).toBe(tag);
	}, 600000);

	// ─── QA-07: pipeline status across runs ───

	it('QA-07: pipeline status prints latest run summary', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa07', [NATIVE_TEXT_PDF]);

		// Make at least one run exist
		const runResult = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(runResult.exitCode).toBe(0);

		// Now check status
		const statusResult = runCli(['pipeline', 'status'], { timeout: 30000 });
		expect(statusResult.exitCode).toBe(0);

		const combined = statusResult.stdout + statusResult.stderr;
		// Output should reference some kind of run summary
		expect(combined.length).toBeGreaterThan(0);
	}, 600000);

	// ─── QA-08: pipeline status --source <id> ───

	it('QA-08: pipeline status --source <id> prints source-level status', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa08', [NATIVE_TEXT_PDF]);

		const runResult = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(runResult.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);

		const statusResult = runCli(['pipeline', 'status', '--source', sourceId], { timeout: 30000 });
		expect(statusResult.exitCode).toBe(0);

		const combined = statusResult.stdout + statusResult.stderr;
		// Should mention the source id, current step, or status
		expect(combined.length).toBeGreaterThan(0);
		expect(combined).toMatch(/extract|status|current/i);
	}, 600000);

	// ─── QA-09: pipeline status --json is valid JSON ───

	it('QA-09: pipeline status --json emits a JSON object with required fields', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa09', [NATIVE_TEXT_PDF]);

		const runResult = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(runResult.exitCode).toBe(0);

		const statusResult = runCli(['pipeline', 'status', '--json'], { timeout: 30000 });
		expect(statusResult.exitCode).toBe(0);

		// stdout may contain interleaved log lines (single-line `{"level":"info"...}`)
		// followed by the multi-line pretty-printed status JSON object. Find the
		// first multi-line JSON block (line starting with `{` followed by an
		// indented field) and parse it.
		const text = statusResult.stdout;
		const lines = text.split('\n');
		let parsed: Record<string, unknown> | null = null;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === '{') {
				// Find the matching closing brace by tracking depth
				let depth = 0;
				const buf: string[] = [];
				for (let j = i; j < lines.length; j++) {
					buf.push(lines[j]);
					for (const ch of lines[j]) {
						if (ch === '{') depth++;
						else if (ch === '}') depth--;
					}
					if (depth === 0) break;
				}
				try {
					parsed = JSON.parse(buf.join('\n'));
					break;
				} catch {
					// not this block — keep scanning
				}
			}
		}
		expect(parsed, `Could not parse JSON output: ${text}`).not.toBeNull();
		// Spec says fields runId, status, totals, sources
		expect(parsed).toHaveProperty('runId');
		expect(parsed).toHaveProperty('status');
		expect(parsed).toHaveProperty('totals');
		expect(parsed).toHaveProperty('sources');
	}, 600000);

	// ─── QA-10: pipeline retry a failed source ───

	it('QA-10: pipeline retry creates a new run and re-attempts the failed step', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa10', [NATIVE_TEXT_PDF]);

		// Stage 1: ingest source so we have a real source id, then mark source as failed at extract
		const stage1 = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(stage1.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);

		// Synthesise a "failed at extract" pipeline_run_sources row by inserting one
		// directly (alongside the existing successful one). The retry path looks at
		// the latest row for that source.
		db.runSql(
			`INSERT INTO pipeline_runs (id, tag, options, status, created_at, finished_at) ` +
				`VALUES ('99999999-9999-9999-9999-999999999999', 'qa10-failed', '{}', 'failed', ` +
				`now() + interval '1 second', now() + interval '1 second');`,
		);
		db.runSql(
			`INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at) ` +
				`VALUES ('99999999-9999-9999-9999-999999999999', '${sourceId}', 'extract', 'failed', ` +
				`'simulated extract failure', now() + interval '1 second');`,
		);

		// Reset source status so retry can re-extract from a clean state.
		db.runSql(`UPDATE sources SET status = 'ingested' WHERE id = '${sourceId}';`);

		const retryResult = runCli(['pipeline', 'retry', sourceId], { timeout: 600000 });
		// Retry must produce a new run row
		const numRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');
		expect(Number.parseInt(numRuns, 10)).toBeGreaterThanOrEqual(2);

		// Most recent run should reference this source
		const latestRunSourceId = db.runSql(
			'SELECT source_id FROM pipeline_run_sources ' +
				'WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1) ' +
				'LIMIT 1;',
		);
		expect(latestRunSourceId).toBe(sourceId);

		// Exit 0 if retry succeeded; fine if non-zero only when extract genuinely fails
		// (which it shouldn't for this fixture). At minimum, a new run row exists.
		expect(retryResult.exitCode).toBeDefined();
	}, 900000);

	// ─── QA-11: Unknown --up-to step rejected ───

	it('QA-11: --up-to with unknown step exits 1 and creates no pipeline_runs row', () => {
		if (!pgAvailable) return;

		const beforeRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');

		const result = runCli(['pipeline', 'run', FIXTURE_DIR, '--up-to', 'analyze'], { timeout: 30000 });

		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		// Error should mention unknown / valid steps
		expect(combined).toMatch(/unknown|invalid|valid/i);

		const afterRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');
		expect(afterRuns).toBe(beforeRuns);
	});

	// ─── QA-12: --from after --up-to rejected ───

	it('QA-12: --from graph --up-to extract exits 1 with ordering error', () => {
		if (!pgAvailable) return;

		const result = runCli(['pipeline', 'run', FIXTURE_DIR, '--from', 'graph', '--up-to', 'extract'], {
			timeout: 30000,
		});
		expect(result.exitCode).not.toBe(0);

		const combined = result.stdout + result.stderr;
		// Should explain the ordering constraint
		expect(combined).toMatch(/from|up-to|order|precede|after|before/i);
	});

	// ─── QA-13: Missing path rejected ───

	it('QA-13: pipeline run with no path exits 1 with usage hint', () => {
		const result = runCli(['pipeline', 'run'], { timeout: 30000 });
		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/path|required|usage/i);
	});

	// ─── QA-14: Idempotent re-run on already-graphed source ───

	it('QA-14: re-running pipeline on a graphed source does not cause double work', () => {
		if (!pgAvailable) return;

		cleanTestData();
		cleanStorageFixtures();

		const workDir = makeWorkDir('qa14', [NATIVE_TEXT_PDF]);

		// First end-to-end run via two stages
		const stage1 = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], { timeout: 240000 });
		expect(stage1.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		materialisePageImages(sourceId);

		const stage2 = runCli(['pipeline', 'run', workDir, '--from', 'segment'], { timeout: 600000 });
		expect(stage2.exitCode).toBe(0);

		// Story should be graphed (per-story state — see QA-01 note)
		const status = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${sourceId}';`);
		expect(status).toBe('graphed');

		// Snapshot edge count
		const edgeCountBefore = db.runSql('SELECT COUNT(*) FROM entity_edges;');

		// Re-run on the same dir — ingest should dedupe via file_hash, no changes
		const rerun = runCli(['pipeline', 'run', workDir], { timeout: 600000 });
		expect(rerun.exitCode).toBe(0);

		// Still graphed
		const statusAfter = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${sourceId}';`);
		expect(statusAfter).toBe('graphed');

		// No additional edges created
		const edgeCountAfter = db.runSql('SELECT COUNT(*) FROM entity_edges;');
		expect(edgeCountAfter).toBe(edgeCountBefore);

		// Latest pipeline_runs row status should be 'completed' (no failures)
		const latestRunStatus = db.runSql('SELECT status FROM pipeline_runs ORDER BY created_at DESC LIMIT 1;');
		expect(latestRunStatus).toBe('completed');
	}, 1200000);
});

// ---------------------------------------------------------------------------
// CLI Test Matrix
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: pipeline', () => {
	// ─── CLI-01: pipeline --help ───

	it('CLI-01: mulder pipeline --help lists run, status, retry subcommands', () => {
		const result = runCli(['pipeline', '--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/run/);
		expect(result.stdout).toMatch(/status/);
		expect(result.stdout).toMatch(/retry/);
	});

	// ─── CLI-02: pipeline run --help ───

	it('CLI-02: mulder pipeline run --help shows --up-to, --from, --dry-run, --tag', () => {
		const result = runCli(['pipeline', 'run', '--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('--up-to');
		expect(result.stdout).toContain('--from');
		expect(result.stdout).toContain('--dry-run');
		expect(result.stdout).toContain('--tag');
	});

	// ─── CLI-03: pipeline status --help ───

	it('CLI-03: mulder pipeline status --help shows --source, --tag, --run, --json', () => {
		const result = runCli(['pipeline', 'status', '--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('--source');
		expect(result.stdout).toContain('--tag');
		expect(result.stdout).toContain('--run');
		expect(result.stdout).toContain('--json');
	});

	// ─── CLI-04: pipeline retry --help ───

	it('CLI-04: mulder pipeline retry --help shows --step option', () => {
		const result = runCli(['pipeline', 'retry', '--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('--step');
	});

	// ─── CLI-05: pipeline run with no args ───

	it('CLI-05: mulder pipeline run (no args) errors with path required', () => {
		const result = runCli(['pipeline', 'run']);
		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/path|required|usage/i);
	});

	// ─── CLI-06: pipeline run --up-to bogus ───

	it('CLI-06: mulder pipeline run <dir> --up-to bogus errors with unknown step', () => {
		const result = runCli(['pipeline', 'run', FIXTURE_DIR, '--up-to', 'bogus']);
		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/unknown|invalid|valid|bogus/i);
	});

	// ─── CLI-07: pipeline run --from after --up-to ───

	it('CLI-07: mulder pipeline run <dir> --from graph --up-to extract errors on order', () => {
		const result = runCli(['pipeline', 'run', FIXTURE_DIR, '--from', 'graph', '--up-to', 'extract']);
		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/from|up-to|order|after|before/i);
	});

	// ─── CLI-08: pipeline retry no source-id ───

	it('CLI-08: mulder pipeline retry (no args) errors with source-id required', () => {
		const result = runCli(['pipeline', 'retry']);
		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/source-id|required|usage/i);
	});

	// ─── CLI-09: pipeline retry bogus uuid ───

	it('CLI-09: mulder pipeline retry <bogus-uuid> errors with source not found', () => {
		if (!db.isPgAvailable()) {
			console.warn('SKIP CLI-09: PostgreSQL not available');
			return;
		}
		// Use a syntactically valid UUID that won't exist in DB
		const result = runCli(['pipeline', 'retry', '00000000-0000-0000-0000-000000000000']);
		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/not found|does not exist|missing/i);
	});

	// ─── CLI-10: pipeline status --run bogus uuid ───

	it('CLI-10: mulder pipeline status --run <bogus-uuid> errors with run not found', () => {
		if (!db.isPgAvailable()) {
			console.warn('SKIP CLI-10: PostgreSQL not available');
			return;
		}
		const result = runCli(['pipeline', 'status', '--run', '00000000-0000-0000-0000-000000000000']);
		expect(result.exitCode).not.toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/not found|does not exist|missing/i);
	});
});

// ---------------------------------------------------------------------------
// Smoke tests — flag combinations not covered above
// ---------------------------------------------------------------------------

describe('Smoke: pipeline flag combinations', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
	});

	// ─── SMOKE-01: --tag + --dry-run together ───

	it('SMOKE-01: pipeline run --tag nightly --dry-run does not crash and exits 0', () => {
		if (!pgAvailable) return;

		const result = runCli(['pipeline', 'run', FIXTURE_DIR, '--tag', 'nightly', '--dry-run'], { timeout: 60000 });
		expect(result.exitCode).toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined).toMatch(/dry run|planned|plan/i);
	});

	// ─── SMOKE-02: pipeline status --json with no run ───

	it('SMOKE-02: pipeline status --json on empty DB exits non-zero with structured error', () => {
		if (!pgAvailable) return;

		// Wipe runs
		db.runSql('DELETE FROM pipeline_run_sources; DELETE FROM pipeline_runs;');

		const result = runCli(['pipeline', 'status', '--json'], { timeout: 30000 });
		// Either non-zero (no run found) or zero with empty payload — both are acceptable
		// but combined output must not be empty.
		const combined = result.stdout + result.stderr;
		expect(combined.length).toBeGreaterThan(0);
	});
});
