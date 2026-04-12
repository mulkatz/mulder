import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 54: v2.0 Schema Migrations (009-011)
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via the shared env-driven SQL helper, and filesystem.
 * Never import from packages/ or src/ or apps/.
 *
 * Requires a running PostgreSQL instance (the standard PG env vars)
 * with pgvector, PostGIS, and pg_trgm extensions available.
 */

const MIGRATIONS_009_011 = ['009_entity_grounding.sql', '010_evidence_chains.sql', '011_spatio_temporal_clusters.sql'];

/**
 * Helper: run the CLI binary via node as a subprocess.
 */
function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function hasRequiredExtensions(): boolean {
	try {
		const out = db.runSql(
			"SELECT count(*) FROM pg_available_extensions WHERE name IN ('vector', 'postgis', 'pg_trgm');",
		);
		return Number.parseInt(out, 10) >= 3;
	} catch {
		return false;
	}
}

function resetDatabase(): void {
	const dropSql = [
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
		'DROP INDEX IF EXISTS idx_entities_geom',
		'DROP EXTENSION IF EXISTS vector CASCADE',
		'DROP EXTENSION IF EXISTS postgis CASCADE',
		'DROP EXTENSION IF EXISTS pg_trgm CASCADE',
	].join('; ');

	db.runSql(dropSql);
}

function migrationFilenames(): string[] {
	const rows = db.runSql('SELECT filename FROM mulder_migrations ORDER BY filename;');
	return rows.split('\n').filter(Boolean);
}

function migrationCount(): number {
	return Number.parseInt(db.runSql('SELECT count(*) FROM mulder_migrations;'), 10);
}

function parseMigrationSummary(output: string): { applied?: number; skipped?: number; total?: number } | null {
	const line = output.split('\n').find((entry) => entry.includes('"msg":"Migration run complete"'));
	if (!line) {
		return null;
	}
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function prepareBackfilledDatabase(): void {
	const cleanupSql = [
		`DELETE FROM mulder_migrations WHERE filename IN ('${MIGRATIONS_009_011.join("', '")}')`,
		'DROP TABLE IF EXISTS spatio_temporal_clusters CASCADE',
		'DROP TABLE IF EXISTS evidence_chains CASCADE',
		'DROP TABLE IF EXISTS entity_grounding CASCADE',
		'ALTER TABLE entities DROP COLUMN IF EXISTS geom',
		'DROP INDEX IF EXISTS idx_entities_geom',
	].join('; ');

	db.runSql(cleanupSql);
}

describe('Spec 54: v2.0 Schema Migrations (009-011)', () => {
	let pgAvailable: boolean;
	let extensionsAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		extensionsAvailable = hasRequiredExtensions();
		if (!extensionsAvailable) {
			console.warn('SKIP: Required extensions (pgvector, PostGIS, pg_trgm) not available in PostgreSQL container.');
			return;
		}

		resetDatabase();

		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Initial migration failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
		}
	});

	afterAll(() => {
		if (pgAvailable && extensionsAvailable) {
			resetDatabase();
			try {
				ensureSchema();
			} catch {
				// Downstream specs call ensureSchema() themselves; teardown must
				// not throw.
			}
		}
	});

	function skipIfUnavailable(): boolean {
		return !pgAvailable || !extensionsAvailable;
	}

	describe('QA-01: Fresh database applies the reserved v2.0 migrations in order', () => {
		it('009-011 are recorded between 008_indexes.sql and 012_job_queue.sql', () => {
			if (skipIfUnavailable()) return;

			expect(migrationCount()).toBeGreaterThanOrEqual(18);

			const filenames = migrationFilenames();
			const start = filenames.indexOf('008_indexes.sql');
			const end = filenames.indexOf('012_job_queue.sql');

			expect(start).toBeGreaterThanOrEqual(0);
			expect(end).toBeGreaterThan(start);
			expect(filenames.slice(start, end + 1)).toEqual([
				'008_indexes.sql',
				'009_entity_grounding.sql',
				'010_evidence_chains.sql',
				'011_spatio_temporal_clusters.sql',
				'012_job_queue.sql',
			]);
		});
	});

	describe('QA-02: Backfilled database accepts 009-011 after 012-018 already exist', () => {
		it('only 009-011 are applied when the ledger already contains 001-008 and 012-018', () => {
			if (skipIfUnavailable()) return;

			prepareBackfilledDatabase();

			const before = migrationFilenames();
			expect(before).not.toContain('009_entity_grounding.sql');
			expect(before).not.toContain('010_evidence_chains.sql');
			expect(before).not.toContain('011_spatio_temporal_clusters.sql');
			expect(before).toContain('012_job_queue.sql');

			const { stdout, stderr, exitCode } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);

			const summary = parseMigrationSummary(combined);
			if (summary) {
				expect(summary.applied).toBe(3);
			}

			const after = migrationFilenames();
			expect(after).toContain('009_entity_grounding.sql');
			expect(after).toContain('010_evidence_chains.sql');
			expect(after).toContain('011_spatio_temporal_clusters.sql');
			expect(after).toContain('012_job_queue.sql');
			expect(migrationCount()).toBeGreaterThanOrEqual(18);
		});
	});

	describe('QA-03: Grounding cache schema matches the contract', () => {
		it('entity_grounding has the expected columns and cascades on entity deletion', () => {
			if (skipIfUnavailable()) return;

			const columns = db.runSql(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'entity_grounding' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const colList = columns.split('\n').filter(Boolean);

			const requiredColumns = ['id', 'entity_id', 'grounding_data', 'source_urls', 'grounded_at', 'expires_at'];
			for (const col of requiredColumns) {
				expect(colList, `Missing column: ${col}`).toContain(col);
			}

			const fkDeleteRule = db.runSql(
				"SELECT rc.delete_rule FROM information_schema.table_constraints tc JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema WHERE tc.table_name = 'entity_grounding' AND tc.constraint_type = 'FOREIGN KEY';",
			);
			expect(fkDeleteRule).toContain('CASCADE');

			const entityId = '00000000-0000-0000-0000-000000540301';
			const groundingId = '00000000-0000-0000-0000-000000540302';

			db.runSql(
				[
					`INSERT INTO entities (id, name, type) VALUES ('${entityId}', 'QA Grounding Entity', 'person')`,
					`INSERT INTO entity_grounding (id, entity_id, grounding_data, source_urls, expires_at) VALUES ('${groundingId}', '${entityId}', '{"title":"Grounded"}'::jsonb, ARRAY['https://example.com/a'], now() + interval '1 day')`,
				].join('; '),
			);

			expect(db.runSql(`SELECT count(*) FROM entity_grounding WHERE id = '${groundingId}';`)).toBe('1');
			db.runSql(`DELETE FROM entities WHERE id = '${entityId}';`);
			expect(db.runSql(`SELECT count(*) FROM entity_grounding WHERE id = '${groundingId}';`)).toBe('0');
		});
	});

	describe('QA-04: Evidence chains schema matches the contract', () => {
		it('evidence_chains matches the expected types and defaults', () => {
			if (skipIfUnavailable()) return;

			const columns = db.runSql(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'evidence_chains' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const colList = columns.split('\n').filter(Boolean);

			for (const col of ['id', 'thesis', 'path', 'strength', 'supports', 'computed_at']) {
				expect(colList, `Missing column: ${col}`).toContain(col);
			}

			const thesisType = db.runSql(
				"SELECT data_type FROM information_schema.columns WHERE table_name = 'evidence_chains' AND column_name = 'thesis';",
			);
			expect(thesisType).toBe('text');

			const pathType = db.runSql(
				"SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'evidence_chains'::regclass AND a.attname = 'path';",
			);
			expect(pathType).toBe('uuid[]');

			const strengthType = db.runSql(
				"SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'evidence_chains'::regclass AND a.attname = 'strength';",
			);
			expect(strengthType).toBe('double precision');

			const supportsType = db.runSql(
				"SELECT data_type FROM information_schema.columns WHERE table_name = 'evidence_chains' AND column_name = 'supports';",
			);
			expect(supportsType).toBe('boolean');

			const computedDefault = db.runSql(
				"SELECT column_default FROM information_schema.columns WHERE table_name = 'evidence_chains' AND column_name = 'computed_at';",
			);
			expect(computedDefault.toLowerCase()).toMatch(/now\(\)|current_timestamp/);
		});
	});

	describe('QA-05: Spatio-temporal schema includes cluster storage and entity geometry support', () => {
		it('spatio_temporal_clusters, entities.geom, and idx_entities_geom match the contract', () => {
			if (skipIfUnavailable()) return;

			const columns = db.runSql(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'spatio_temporal_clusters' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const colList = columns.split('\n').filter(Boolean);

			for (const col of [
				'id',
				'center_lat',
				'center_lng',
				'time_start',
				'time_end',
				'event_count',
				'event_ids',
				'cluster_type',
				'computed_at',
			]) {
				expect(colList, `Missing column: ${col}`).toContain(col);
			}

			const eventCountType = db.runSql(
				"SELECT data_type FROM information_schema.columns WHERE table_name = 'spatio_temporal_clusters' AND column_name = 'event_count';",
			);
			expect(eventCountType).toBe('integer');

			const eventIdsType = db.runSql(
				"SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'spatio_temporal_clusters'::regclass AND a.attname = 'event_ids';",
			);
			expect(eventIdsType).toBe('uuid[]');

			const computedDefault = db.runSql(
				"SELECT column_default FROM information_schema.columns WHERE table_name = 'spatio_temporal_clusters' AND column_name = 'computed_at';",
			);
			expect(computedDefault.toLowerCase()).toMatch(/now\(\)|current_timestamp/);

			const geomType = db
				.runSql(
					"SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'entities'::regclass AND a.attname = 'geom';",
				)
				.replace(/\s+/g, '');
			expect(geomType).toBe('geometry(Point,4326)');

			const geomIndex = db.runSql(
				"SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_entities_geom';",
			);
			expect(geomIndex.toLowerCase()).toContain('using gist');
			expect(geomIndex.toLowerCase()).toContain('(geom)');
		});
	});

	describe('QA-06: Re-running migrations is idempotent after 009-011 are installed', () => {
		it('db migrate reports no newly applied migrations on a second run', () => {
			if (skipIfUnavailable()) return;

			const { stdout, stderr, exitCode } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);
			const summary = parseMigrationSummary(combined);
			if (summary) {
				expect(summary.applied).toBe(0);
			}
			expect(combined.toLowerCase()).toMatch(/up to date|applied 0|0.*applied|no pending migrations/);
		});
	});
});
