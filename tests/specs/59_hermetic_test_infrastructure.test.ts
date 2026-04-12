import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CI_WORKFLOW = resolve(ROOT, '.github/workflows/ci.yml');
const GCP_WORKFLOW = resolve(ROOT, '.github/workflows/gcp-tests.yml');
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
			'DROP TABLE IF EXISTS pipeline_run_sources CASCADE',
			'DROP TABLE IF EXISTS pipeline_runs CASCADE',
			'DROP TABLE IF EXISTS jobs CASCADE',
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
			'DROP TABLE IF EXISTS source_steps CASCADE',
			'DROP TABLE IF EXISTS sources CASCADE',
			'DROP TABLE IF EXISTS mulder_migrations CASCADE',
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

	it('QA-05: CI runs Spec 44 as an explicit health signal before the wider suite', () => {
		const ciWorkflow = readFileSync(CI_WORKFLOW, 'utf-8');
		const gcpWorkflow = readFileSync(GCP_WORKFLOW, 'utf-8');

		expect(ciWorkflow).toContain('Run E2E health check (Spec 44)');
		expect(ciWorkflow).toContain('pnpm test:health');
		expect(gcpWorkflow).toContain('workflow_dispatch');
		expect(gcpWorkflow).toContain('schedule:');
	});
});
