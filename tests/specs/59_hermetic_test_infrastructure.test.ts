import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CI_WORKFLOW = resolve(ROOT, '.github/workflows/ci.yml');
const GCP_WORKFLOW = resolve(ROOT, '.github/workflows/gcp-tests.yml');
const README = resolve(ROOT, 'README.md');
const TESTING_STRATEGY_DOC = resolve(ROOT, 'docs/testing-strategy.md');
const TEST_SCOPE_SCRIPT = resolve(ROOT, 'scripts/test-scope.mjs');
const PACKAGE_JSON = resolve(ROOT, 'package.json');

function runVitest(args: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('pnpm', ['vitest', 'run', ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 240_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			NODE_ENV: 'test',
			PGHOST: db.TEST_PG_HOST,
			PGPORT: String(db.TEST_PG_PORT),
			PGUSER: db.TEST_PG_USER,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			PGDATABASE: db.TEST_PG_DATABASE,
			...env,
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function resetSchemaToMissing(): void {
	db.runSql(
		[
			'DROP FUNCTION IF EXISTS reset_pipeline_step CASCADE',
			'DROP FUNCTION IF EXISTS gc_orphaned_entities CASCADE',
			'DROP TABLE IF EXISTS monthly_budget_reservations CASCADE',
			'DROP TABLE IF EXISTS pipeline_run_sources CASCADE',
			'DROP TABLE IF EXISTS pipeline_runs CASCADE',
			'DROP TABLE IF EXISTS jobs CASCADE',
			'DROP TABLE IF EXISTS monthly_budget_reservations CASCADE',
			'DROP TABLE IF EXISTS api_sessions CASCADE',
			'DROP TABLE IF EXISTS api_invitations CASCADE',
			'DROP TABLE IF EXISTS api_users CASCADE',
			'DROP TABLE IF EXISTS document_blobs CASCADE',
			'DROP TYPE IF EXISTS job_status CASCADE',
			'DROP TABLE IF EXISTS chunks CASCADE',
			'DROP TABLE IF EXISTS story_entities CASCADE',
			'DROP TABLE IF EXISTS entity_edges CASCADE',
			'DROP TABLE IF EXISTS entity_aliases CASCADE',
			'DROP TABLE IF EXISTS taxonomy CASCADE',
			'DROP TABLE IF EXISTS entities CASCADE',
			'DROP TABLE IF EXISTS stories CASCADE',
			'DROP TABLE IF EXISTS spatio_temporal_clusters CASCADE',
			'DROP TABLE IF EXISTS evidence_chains CASCADE',
			'DROP TABLE IF EXISTS entity_grounding CASCADE',
			'DROP TABLE IF EXISTS url_lifecycle CASCADE',
			'DROP TABLE IF EXISTS url_host_lifecycle CASCADE',
			'DROP TABLE IF EXISTS source_steps CASCADE',
			'DROP TABLE IF EXISTS sources CASCADE',
			'DROP TABLE IF EXISTS mulder_migrations CASCADE',
			'DROP TYPE IF EXISTS source_type CASCADE',
		].join('; '),
	);
}

describe('Spec 59 — Hermetic Test Infrastructure', () => {
	it.skipIf(!db.isPgAvailable())('QA-01: defensive cleanup succeeds even when Mulder tables do not exist', () => {
		resetSchemaToMissing();
		expect(() => truncateMulderTables()).not.toThrow();
		ensureSchema();
	});

	it.skipIf(!db.isPgAvailable())('QA-02: spec 25 is independently runnable on a fresh database', () => {
		resetSchemaToMissing();

		const result = runVitest(['tests/specs/25_edge_repository.test.ts']);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	it('QA-03: default fixture-generator and Document AI suites stay green without GCP opt-in', () => {
		const result = runVitest(
			['tests/specs/20_fixture_generator.test.ts', 'tests/specs/47_document_ai_extraction.test.ts'],
			{
				MULDER_TEST_GCP: 'false',
				MULDER_E2E_GCP: 'false',
			},
		);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	it('QA-04: the repo exposes one canonical opt-in GCP lane', () => {
		const packageJson = readFileSync(PACKAGE_JSON, 'utf-8');
		const gcpWorkflow = readFileSync(GCP_WORKFLOW, 'utf-8');

		expect(packageJson).toContain('"test:gcp"');
		expect(gcpWorkflow).toContain('MULDER_TEST_GCP: "true"');
		expect(gcpWorkflow).toContain('pnpm test:gcp');
	});

	it('QA-05: CI separates fast PR feedback from the full milestone gate', () => {
		const ciWorkflow = readFileSync(CI_WORKFLOW, 'utf-8');
		const gcpWorkflow = readFileSync(GCP_WORKFLOW, 'utf-8');

		expect(ciWorkflow).toContain("if: github.event_name == 'pull_request'");
		expect(ciWorkflow).toContain('pr-affected-tests');
		expect(ciWorkflow).toContain('full-schema-tests');
		expect(ciWorkflow).toContain('full-db-tests');
		expect(ciWorkflow).toContain('full-heavy-tests');
		expect(ciWorkflow).toContain('full-external-tests');
		expect(ciWorkflow).toContain('pnpm test:affected');
		expect(ciWorkflow).toContain('pnpm test:lane -- schema');
		expect(ciWorkflow).toContain('pnpm test:lane -- db');
		expect(ciWorkflow).toContain('pnpm test:lane -- heavy');
		expect(ciWorkflow).toContain('Run E2E health check (Spec 44)');
		expect(ciWorkflow).toContain('pnpm test:health');
		expect(ciWorkflow).toContain('MULDER_TEST_SKIP_HEALTH_SPEC_IN_AFFECTED: "true"');
		expect(gcpWorkflow).toContain('workflow_dispatch');
		expect(gcpWorkflow).toContain('schedule:');
	});

	it('QA-05b: scoped test runs preserve lane isolation and serial DB execution', () => {
		const scopeScript = readFileSync(TEST_SCOPE_SCRIPT, 'utf-8');

		expect(scopeScript).toContain("const SERIAL_VITEST_ARGS = ['--no-file-parallelism', '--maxWorkers=1']");
		expect(scopeScript).toContain("const LANE_ORDER = ['unit', 'schema', 'db', 'heavy', 'external']");
		expect(scopeScript).toContain('rewriteJUnitOutputArgs');
		expect(scopeScript).toMatch(/scope-\$\{selection\.scopeType\}-\$\{selection\.scopeValue\}-\$\{laneName\}/);
	});

	it('QA-05c: test lane ownership is documented for future contributors', () => {
		const readme = readFileSync(README, 'utf-8');
		const testingStrategy = readFileSync(TESTING_STRATEGY_DOC, 'utf-8');

		expect(readme).toContain('./docs/testing-strategy.md');
		expect(testingStrategy).toContain('Prefer `unit` for pure package/app behavior');
		expect(testingStrategy).toContain(
			'Put tests that require real Docker, GCP credentials, paid services, or live external services in `external`',
		);
		expect(testingStrategy).toContain('pnpm test:lanes:verify');
	});

	it('QA-06: the lane runner and dev storage honor isolated test storage roots', () => {
		const storageRoot = mkdtempSync(resolve(ROOT, '.local/test-storage-qa59-'));
		try {
			const result = spawnSync(
				'node',
				[
					'scripts/test-runner.mjs',
					'run',
					'qa59-storage',
					'--',
					'node',
					'--input-type=module',
					'-e',
					[
						"const core = await import('./packages/core/dist/index.js');",
						"const config = await core.loadConfig('./mulder.config.example.yaml');",
						"const logger = core.createLogger({ level: 'silent' });",
						'const pool = core.getWorkerPool(config.gcp.cloud_sql);',
						"const db = await pool.query('select current_database() as database');",
						"if (db.rows[0].database !== process.env.PGDATABASE) throw new Error('pool connected to ' + db.rows[0].database + ', expected ' + process.env.PGDATABASE);",
						'await core.closeAllPools();',
						'const services = core.createServiceRegistry({ ...config, dev_mode: true }, logger);',
						"await services.storage.upload('raw/qa59-storage.txt', Buffer.from('ok'));",
					].join(' '),
				],
				{
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 60_000,
					stdio: ['pipe', 'pipe', 'pipe'],
					env: {
						...process.env,
						NODE_ENV: 'test',
						MULDER_TEST_STORAGE_ROOT: storageRoot,
						MULDER_TEST_ISOLATED_DB: 'true',
					},
				},
			);

			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(existsSync(join(storageRoot, 'raw/qa59-storage.txt'))).toBe(true);
			expect(existsSync(resolve(ROOT, '.local/storage/raw/qa59-storage.txt'))).toBe(false);
		} finally {
			rmSync(storageRoot, { recursive: true, force: true });
		}
	});
});
