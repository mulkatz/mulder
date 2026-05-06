/**
 * Shared test helper: ensure the Postgres schema exists before a spec runs.
 *
 * Spec 08's `afterAll` drops every table and every extension to verify the
 * migration runner can re-create a clean database. Tests that run afterwards
 * and need the schema must re-migrate in their own `beforeAll` — this helper
 * is the canonical way to do that.
 *
 * Usage:
 *
 *   import { ensureSchema } from '../lib/schema.js';
 *
 *   beforeAll(() => {
 *     if (!pgAvailable) return;
 *     ensureSchema();
 *     // ... rest of fixture setup
 *   });
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runSql, TEST_PG_ENV } from './db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

export const MULDER_TEST_TABLES = [
	'chunks',
	'story_entities',
	'entity_edges',
	'entity_aliases',
	'taxonomy',
	'entities',
	'stories',
	'entity_grounding',
	'evidence_chains',
	'spatio_temporal_clusters',
	'pipeline_run_sources',
	'pipeline_runs',
	'jobs',
	'monthly_budget_reservations',
	'url_lifecycle',
	'url_host_lifecycle',
	'api_sessions',
	'api_invitations',
	'api_users',
	'custody_steps',
	'original_sources',
	'archive_locations',
	'acquisition_contexts',
	'collections',
	'archives',
	'document_blobs',
	'document_quality_assessments',
	'source_steps',
	'sources',
] as const;

/**
 * Run `mulder db migrate` against the example config and throw if migrations
 * fail. Idempotent — safe to call multiple times per test suite.
 */
export function ensureSchema(): void {
	const result = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ...TEST_PG_ENV, MULDER_LOG_LEVEL: 'silent' },
	});
	if (result.status !== 0) {
		throw new Error(
			`ensureSchema: db migrate failed (exit ${result.status}):\n` +
				`stdout: ${result.stdout ?? ''}\n` +
				`stderr: ${result.stderr ?? ''}`,
		);
	}
}

function quoteSqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function quoteSqlIdentifier(identifier: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
		throw new Error(`Unsupported SQL identifier for test cleanup: ${identifier}`);
	}
	return `"${identifier}"`;
}

export function truncateExistingTables(tables: readonly string[]): void {
	if (tables.length === 0) {
		return;
	}

	const requestedTables = [...new Set(tables)];
	const existingRows = runSql(
		[
			'SELECT tablename',
			'FROM pg_tables',
			"WHERE schemaname = 'public'",
			`  AND tablename IN (${requestedTables.map(quoteSqlLiteral).join(', ')})`,
			'ORDER BY tablename;',
		].join('\n'),
	);
	const existingTables = existingRows.split('\n').filter(Boolean);

	if (existingTables.length === 0) {
		return;
	}

	runSql(`TRUNCATE TABLE ${existingTables.map(quoteSqlIdentifier).join(', ')} CASCADE;`);
}

export function truncateMulderTables(): void {
	truncateExistingTables(MULDER_TEST_TABLES);
}
