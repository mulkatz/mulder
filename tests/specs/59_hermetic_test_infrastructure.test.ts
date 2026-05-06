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
const TEST_LANES_SCRIPT = resolve(ROOT, 'scripts/test-lanes.mjs');
const PACKAGE_JSON = resolve(ROOT, 'package.json');

type AffectedPlan = {
	totalFiles: number;
	lanes: Record<string, { count: number; files: string[]; totalWeight: number }>;
	files: Array<{ relativePath: string; lane: string; weight: number }>;
	rules: Array<{ changedFile: string; rule: string; selectedFiles: string[] }>;
};

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

function runTestLanes(args: string[]): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [TEST_LANES_SCRIPT, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function affectedPlanFor(changedFile: string): AffectedPlan {
	const result = runTestLanes(['affected-plan', '--changed-file', changedFile, '--json']);
	expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
	return JSON.parse(result.stdout) as AffectedPlan;
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
		expect(ciWorkflow).toContain("startsWith(github.ref, 'refs/heads/milestone/')");
		expect(ciWorkflow).toContain('pr-affected-plan');
		expect(ciWorkflow).toContain('pr-affected-schema');
		expect(ciWorkflow).toContain('pr-affected-db');
		expect(ciWorkflow).toContain('pr-affected-heavy');
		expect(ciWorkflow).toContain('pr-affected-tests');
		expect(ciWorkflow).toContain('Check affected lane results');
		expect(ciWorkflow).toContain('needs: build');
		expect(ciWorkflow).toContain('needs: [build, pr-affected-plan]');
		expect(ciWorkflow).toContain(
			'needs: [pr-affected-plan, health, pr-affected-schema, pr-affected-db, pr-affected-heavy]',
		);
		expect(ciWorkflow).toContain(['echo "health: $', '{{ needs.health.result }}"'].join(''));
		expect(ciWorkflow).not.toContain('needs: [build, health]');
		expect(ciWorkflow).toContain('full-schema-tests');
		expect(ciWorkflow).toContain('full-db-tests');
		expect(ciWorkflow).toContain('full-heavy-tests');
		expect(ciWorkflow).toContain('full-external-tests');
		expect(ciWorkflow).toContain(['BASE_REF="$', '{{ github.event.before }}"'].join(''));
		expect(ciWorkflow).toContain(['BASE_REF="origin/$', '{{ github.base_ref }}"'].join(''));
		expect(ciWorkflow).toContain('--json > .test-results/affected-plan.json');
		expect(ciWorkflow).toContain('pnpm test:affected:lane -- schema');
		expect(ciWorkflow).toContain('pnpm test:affected:lane -- db');
		expect(ciWorkflow).toContain('pnpm test:affected:lane -- heavy');
		expect(ciWorkflow).toContain('pnpm test:lane -- schema');
		expect(ciWorkflow).toContain('pnpm test:lane -- db');
		expect(ciWorkflow).toContain('pnpm test:lane -- heavy');
		expect(ciWorkflow).toContain(
			"if: github.event_name != 'pull_request' && (github.event_name != 'push' || !startsWith(github.ref, 'refs/heads/milestone/'))",
		);
		expect(ciWorkflow).toContain('Run E2E health check (Spec 44)');
		expect(ciWorkflow).toContain('pnpm test:health');
		expect(ciWorkflow).toContain('MULDER_TEST_SKIP_HEALTH_SPEC_IN_AFFECTED: "true"');
		expect(ciWorkflow).toContain('MULDER_TEST_AFFECTED_PR_HEAD_DOCS_ONLY: "true"');
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
		expect(testingStrategy).toContain('pnpm test:affected:plan');
		expect(testingStrategy).toContain('normal feature PR should stay near 8-15 minutes');
		expect(testingStrategy).toContain('pnpm test:lanes:verify');
	});

	it('QA-05d: affected planning stays narrow for reprocess config changes', () => {
		const plan = affectedPlanFor('packages/core/src/config/reprocess-hash.ts');
		const files = plan.files.map((file) => file.relativePath);

		expect(plan.totalFiles).toBeLessThan(20);
		expect(files).toEqual(
			expect.arrayContaining([
				'tests/specs/03_config_loader.test.ts',
				'tests/specs/77_cost_estimator.test.ts',
				'tests/specs/78_selective_reprocessing.test.ts',
				'tests/specs/100_document_quality_assessment_step.test.ts',
			]),
		);
		expect(files).not.toContain('tests/specs/77_large_pdf_browser_upload_flow.test.ts');
		expect(files).not.toContain('tests/specs/78_devlog_system.test.ts');
		expect(plan.lanes.heavy.count).toBe(0);
	});

	it('QA-05e: testinfra changes select infrastructure smokes instead of the full suite', () => {
		const plan = affectedPlanFor('scripts/test-lanes.mjs');
		const files = plan.files.map((file) => file.relativePath);

		expect(plan.totalFiles).toBe(2);
		expect(files).toEqual(
			expect.arrayContaining([
				'tests/specs/02_monorepo_setup.test.ts',
				'tests/specs/59_hermetic_test_infrastructure.test.ts',
			]),
		);
		expect(plan.lanes.heavy.count).toBe(0);
		expect(plan.lanes.db.count + plan.lanes.schema.count).toBe(2);
	});

	it('QA-05e2: affected planning maps colliding spec docs to exact tests', () => {
		const plan = affectedPlanFor('docs/specs/77_cost_estimator.spec.md');
		const files = plan.files.map((file) => file.relativePath);

		expect(plan.totalFiles).toBe(1);
		expect(files).toEqual(['tests/specs/77_cost_estimator.test.ts']);
		expect(files).not.toContain('tests/specs/77_large_pdf_browser_upload_flow.test.ts');
		expect(files).not.toContain('tests/specs/77_document_observability_route.test.ts');
	});

	it('QA-05e3: package-level affected planning uses package-specific mappings', () => {
		const retrievalPlan = affectedPlanFor('packages/retrieval/src/orchestrator.ts');
		const taxonomyPlan = affectedPlanFor('packages/taxonomy/src/merge.ts');

		expect(retrievalPlan.files.map((file) => file.relativePath)).toEqual(
			expect.arrayContaining([
				'tests/specs/37_vector_search_retrieval.test.ts',
				'tests/specs/42_hybrid_retrieval_orchestrator.test.ts',
				'tests/specs/43_retrieval_metrics.test.ts',
			]),
		);
		expect(retrievalPlan.totalFiles).toBeLessThan(10);
		expect(retrievalPlan.lanes.heavy.count).toBe(0);

		expect(taxonomyPlan.files.map((file) => file.relativePath)).toEqual(
			expect.arrayContaining([
				'tests/specs/27_taxonomy_normalization.test.ts',
				'tests/specs/50_taxonomy_export_curate_merge.test.ts',
			]),
		);
		expect(taxonomyPlan.totalFiles).toBeLessThan(10);
	});

	it('QA-05f: affected lane shards pass cleanly when their selected shard is empty', () => {
		const emptyDbShard = runTestLanes([
			'affected-lane',
			'db',
			'2',
			'2',
			'--changed-file',
			'scripts/test-lanes.mjs',
			'--',
			'--reporter=verbose',
		]);
		const emptyHeavyShard = runTestLanes([
			'affected-lane',
			'heavy',
			'1',
			'3',
			'--changed-file',
			'packages/core/src/config/reprocess-hash.ts',
			'--',
			'--reporter=verbose',
		]);

		expect(emptyDbShard.exitCode, `${emptyDbShard.stdout}\n${emptyDbShard.stderr}`).toBe(0);
		expect(emptyDbShard.stdout).toContain('No tests selected for affected-db-2-of-2; passing.');
		expect(emptyHeavyShard.exitCode, `${emptyHeavyShard.stdout}\n${emptyHeavyShard.stderr}`).toBe(0);
		expect(emptyHeavyShard.stdout).toContain('No tests selected for affected-heavy-1-of-3; passing.');
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
