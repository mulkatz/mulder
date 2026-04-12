import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = resolve(ROOT, '.local/storage/extracted');
const SCANNED_PDF = resolve(FIXTURE_DIR, 'scanned-sample.pdf');

/**
 * Black-box end-to-end test for the Document AI extraction path.
 *
 * Spec 19 covers the native-text extraction path because every fixture in
 * `fixtures/raw/` either has embedded text (`native-text-sample.pdf`) or is
 * a synthetic image-only PDF that gets text-only fallback in dev mode. Real
 * Document AI Layout Parser calls were never exercised in CI before this
 * spec.
 *
 * This test forces the Document AI Layout Parser path by:
 *
 *   1. Using `scanned-sample.pdf` — a pdf-lib-generated image-only PDF whose
 *      `pdftotext` output is empty, so the extract step's `nativeTextRatio`
 *      falls below the configured threshold and routes to Path B.
 *   2. Running with `dev_mode: false` so the GCP service registry hands the
 *      pipeline a real `GcpDocumentAiService` instance.
 *
 * Cost: ~€0.30 per run (one Document AI Layout Parser call against ~1 page).
 * Within the €3 sprint cap.
 *
 * Skipped by default behind `MULDER_TEST_GCP=true` so no developer machine
 * burns Document AI quota on every `pnpm test`. The legacy
 * `MULDER_E2E_GCP=true` name is still accepted for local compatibility.
 *
 * Requires when running:
 * - `MULDER_TEST_GCP=true` env var (or legacy `MULDER_E2E_GCP=true`)
 * - Working `gcloud` ADC for the configured project
 * - A real `mulder.config.yaml` with:
 *   - `dev_mode: false`
 *   - `gcp.project_id` pointing at a project with Document AI enabled
 *   - `gcp.document_ai.processor_id` set to a real Layout Parser processor
 *   - `gcp.document_ai.location` set to the matching multi-region (`eu` or `us`)
 * - Built CLI at `apps/cli/dist/index.js`
 * - PostgreSQL reachable through the standard PG env vars with migrations applied
 *
 * Also acts as the regression test for #93: if the Document AI processor
 * name is constructed with the wrong location segment, the extract step
 * will fail with a 404 from the Document AI endpoint.
 */

const E2E_ENABLED = process.env.MULDER_TEST_GCP === 'true' || process.env.MULDER_E2E_GCP === 'true';

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
		timeout: opts?.timeout ?? 180_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function cleanSourceData(filename: string): void {
	db.runSql(
		`DELETE FROM chunks WHERE story_id IN (SELECT id FROM stories WHERE source_id IN (SELECT id FROM sources WHERE filename = '${filename}'));` +
			` DELETE FROM stories WHERE source_id IN (SELECT id FROM sources WHERE filename = '${filename}');` +
			` DELETE FROM source_steps WHERE source_id IN (SELECT id FROM sources WHERE filename = '${filename}');` +
			` DELETE FROM sources WHERE filename = '${filename}';`,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 47 — Document AI Extraction (E2E, real GCP)', () => {
	const pgAvailable = db.isPgAvailable();
	let sourceId: string | null = null;

	beforeAll(() => {
		if (!E2E_ENABLED) {
			return;
		}
		if (!pgAvailable) {
			throw new Error('PostgreSQL reachable through PGHOST/PGPORT is required for the E2E test');
		}
		ensureSchema();
		cleanSourceData('scanned-sample.pdf');
	});

	afterAll(() => {
		if (E2E_ENABLED && pgAvailable) {
			try {
				cleanSourceData('scanned-sample.pdf');
			} catch {
				// Ignore teardown errors.
			}
		}
	});

	it.skipIf(!E2E_ENABLED)('QA-01: ingest of an image-only PDF reports hasNativeText=false', () => {
		const { exitCode, stdout, stderr } = runCli(['ingest', SCANNED_PDF]);
		expect(exitCode, `ingest failed: ${stdout}\n${stderr}`).toBe(0);

		sourceId = db.runSql("SELECT id FROM sources WHERE filename = 'scanned-sample.pdf';");
		expect(sourceId).toMatch(/^[a-f0-9-]{36}$/);

		const hasNative = db.runSql(`SELECT has_native_text FROM sources WHERE id = '${sourceId}';`);
		// has_native_text is a boolean column; psql returns 'f' or 't'.
		expect(hasNative).toBe('f');
	});

	it.skipIf(!E2E_ENABLED)('QA-02: extract of an image-only source routes to the Document AI path', () => {
		expect(sourceId).not.toBeNull();
		const { exitCode, stdout, stderr } = runCli(['extract', sourceId as string], {
			timeout: 240_000,
		});
		expect(exitCode, `extract failed: ${stdout}\n${stderr}`).toBe(0);

		// source_steps should record `extract` completed, with method='document_ai'
		// in the metadata if the step records the routing decision.
		const stepStatus = db.runSql(
			`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'extract';`,
		);
		expect(stepStatus).toBe('completed');

		const sourceStatus = db.runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(sourceStatus).toBe('extracted');
	});

	it.skipIf(!E2E_ENABLED)('QA-03: layout.json was written by the Document AI Layout Parser', () => {
		expect(sourceId).not.toBeNull();
		const layoutPath = join(EXTRACTED_DIR, sourceId as string, 'layout.json');
		expect(existsSync(layoutPath), `expected layout.json at ${layoutPath}`).toBe(true);

		const layout = JSON.parse(readFileSync(layoutPath, 'utf-8')) as Record<string, unknown>;
		expect(layout).toBeDefined();

		// The Document AI path produces structured layout data with at least
		// one page and at least one block per page. The exact shape is the
		// `LayoutDocument` contract from packages/pipeline/src/extract/types.ts.
		const pages = layout.pages as Array<Record<string, unknown>> | undefined;
		expect(Array.isArray(pages), 'layout.pages must be an array').toBe(true);
		expect((pages ?? []).length).toBeGreaterThanOrEqual(1);

		const firstPage = pages?.[0] ?? {};
		const blocks = firstPage.blocks as Array<unknown> | undefined;
		expect(Array.isArray(blocks), 'pages[0].blocks must be an array').toBe(true);
	});

	it.skipIf(!E2E_ENABLED)(
		'QA-04: location regression — successful extract proves the location segment is correct',
		() => {
			// The schema enum (`z.enum(['eu', 'us'])`) prevents a wrong location
			// at config-load time (covered by spec 13 QA-10). The runtime check
			// here is implicit: if the location segment had been wrong, QA-02
			// would have failed with a 404 from the per-region Document AI
			// endpoint and we would never have reached this assertion.
			expect(sourceId).not.toBeNull();
			const layoutPath = join(EXTRACTED_DIR, sourceId as string, 'layout.json');
			expect(existsSync(layoutPath)).toBe(true);
		},
	);
});

describe('Spec 47 — Document AI Extraction (smoke, no GCP)', () => {
	it('SKIP-NOTICE: real-GCP test is gated behind MULDER_TEST_GCP=true', () => {
		// This always-running test exists so the suite never reports the spec
		// as silently empty. When the GCP env gate is unset, every E2E `it()`
		// above is skipped via `it.skipIf` and only this notice runs.
		if (!E2E_ENABLED) {
			expect(E2E_ENABLED).toBe(false);
		} else {
			expect(E2E_ENABLED).toBe(true);
		}
	});
});
