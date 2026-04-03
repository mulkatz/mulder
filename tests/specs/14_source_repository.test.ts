import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');

/**
 * Black-box QA tests for Spec 14: Source Repository
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `docker exec psql`, and Node subprocess scripts.
 * Never import from packages/ or src/ or apps/.
 *
 * Requires a running PostgreSQL instance (Docker container `mulder-pg-test`)
 * with migrations applied.
 */

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

const DB_CONFIG_JSON = JSON.stringify({
	instance_name: 'mulder-db',
	database: 'mulder',
	tier: 'db-custom-2-8192',
	host: 'localhost',
	port: 5432,
	user: 'mulder',
});

let tmpDir: string;

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
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Helper: run a Node.js helper script as a subprocess.
 */
function runScript(
	scriptContent: string,
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const scriptPath = join(tmpDir, `helper-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(scriptPath, scriptContent, 'utf-8');

	const result = spawnSync('node', [scriptPath], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Helper: run SQL via docker exec psql. Returns query output.
 */
function runSql(sql: string): string {
	const result = spawnSync(
		'docker',
		['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
		{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

function isPgAvailable(): boolean {
	try {
		const result = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return result.status === 0;
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
		'DROP TABLE IF EXISTS source_steps CASCADE',
		'DROP TABLE IF EXISTS sources CASCADE',
		'DROP TABLE IF EXISTS mulder_migrations CASCADE',
		'DROP EXTENSION IF EXISTS vector CASCADE',
		'DROP EXTENSION IF EXISTS postgis CASCADE',
		'DROP EXTENSION IF EXISTS pg_trgm CASCADE',
	].join('; ');

	spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-c', dropSql], {
		encoding: 'utf-8',
		timeout: 15000,
	});
}

/**
 * Clean all rows from sources and source_steps without dropping the tables.
 */
function cleanSourceData(): void {
	runSql('DELETE FROM source_steps; DELETE FROM sources;');
}

describe('Spec 14: Source Repository', () => {
	let pgAvailable: boolean;

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
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-14-'));

		// Full reset and run migrations to ensure clean schema
		resetDatabase();
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		if (pgAvailable) {
			resetDatabase();
		}
	});

	// ─── QA-01: Create source inserts row ───

	describe('QA-01: Create source inserts row', () => {
		it('createSource inserts a row with status ingested and all fields match', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const source = await createSource(pool, {
						filename: 'test-doc.pdf',
						storagePath: 'raw/test-doc.pdf',
						fileHash: 'hash_qa01_' + Date.now(),
						pageCount: 10,
						tags: ['test', 'qa'],
						metadata: { origin: 'qa-test' },
					});

					process.stderr.write('ID:' + source.id + '\\n');
					process.stderr.write('FILENAME:' + source.filename + '\\n');
					process.stderr.write('STORAGE_PATH:' + source.storagePath + '\\n');
					process.stderr.write('STATUS:' + source.status + '\\n');
					process.stderr.write('PAGE_COUNT:' + source.pageCount + '\\n');
					process.stderr.write('TAGS:' + JSON.stringify(source.tags) + '\\n');
					process.stderr.write('HAS_ID:' + (typeof source.id === 'string' && source.id.length > 0) + '\\n');
					process.stderr.write('HAS_CREATED_AT:' + (source.createdAt instanceof Date) + '\\n');
					process.stderr.write('HAS_UPDATED_AT:' + (source.updatedAt instanceof Date) + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('FILENAME:test-doc.pdf');
			expect(combined).toContain('STORAGE_PATH:raw/test-doc.pdf');
			expect(combined).toContain('STATUS:ingested');
			expect(combined).toContain('PAGE_COUNT:10');
			expect(combined).toContain('HAS_ID:true');
			expect(combined).toContain('HAS_CREATED_AT:true');
			expect(combined).toContain('HAS_UPDATED_AT:true');

			// Verify in database via psql
			const rowCount = runSql("SELECT COUNT(*) FROM sources WHERE filename = 'test-doc.pdf';");
			expect(rowCount).toBe('1');
		});
	});

	// ─── QA-02: Create source is idempotent on file_hash ───

	describe('QA-02: Create source is idempotent on file_hash', () => {
		it('duplicate file_hash returns existing source with updated updated_at, no duplicate row', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const fixedHash = 'hash_qa02_idempotent';

			const { stdout, stderr } = runScript(`
				import { createSource, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const first = await createSource(pool, {
						filename: 'first.pdf',
						storagePath: 'raw/first.pdf',
						fileHash: '${fixedHash}',
					});

					// Small delay to ensure updated_at differs
					await new Promise(r => setTimeout(r, 50));

					const second = await createSource(pool, {
						filename: 'duplicate.pdf',
						storagePath: 'raw/duplicate.pdf',
						fileHash: '${fixedHash}',
					});

					process.stderr.write('FIRST_ID:' + first.id + '\\n');
					process.stderr.write('SECOND_ID:' + second.id + '\\n');
					process.stderr.write('SAME_ID:' + (first.id === second.id) + '\\n');
					process.stderr.write('UPDATED_AT_REFRESHED:' + (second.updatedAt >= first.updatedAt) + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('SAME_ID:true');
			expect(combined).toContain('UPDATED_AT_REFRESHED:true');

			// Verify no duplicate in DB
			const count = runSql(`SELECT COUNT(*) FROM sources WHERE file_hash = '${fixedHash}';`);
			expect(count).toBe('1');
		});
	});

	// ─── QA-03: Find source by ID returns correct record ───

	describe('QA-03: Find source by ID returns correct record', () => {
		it('findSourceById returns all fields matching the created record', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, findSourceById, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const created = await createSource(pool, {
						filename: 'find-by-id.pdf',
						storagePath: 'raw/find-by-id.pdf',
						fileHash: 'hash_qa03_' + Date.now(),
						pageCount: 5,
						tags: ['lookup'],
					});

					const found = await findSourceById(pool, created.id);

					process.stderr.write('FOUND:' + (found !== null) + '\\n');
					process.stderr.write('ID_MATCH:' + (found.id === created.id) + '\\n');
					process.stderr.write('FILENAME_MATCH:' + (found.filename === created.filename) + '\\n');
					process.stderr.write('HASH_MATCH:' + (found.fileHash === created.fileHash) + '\\n');
					process.stderr.write('STATUS_MATCH:' + (found.status === created.status) + '\\n');
					process.stderr.write('PAGE_COUNT_MATCH:' + (found.pageCount === created.pageCount) + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('FOUND:true');
			expect(combined).toContain('ID_MATCH:true');
			expect(combined).toContain('FILENAME_MATCH:true');
			expect(combined).toContain('HASH_MATCH:true');
			expect(combined).toContain('STATUS_MATCH:true');
			expect(combined).toContain('PAGE_COUNT_MATCH:true');
		});
	});

	// ─── QA-04: Find source by ID returns null for missing ───

	describe('QA-04: Find source by ID returns null for missing', () => {
		it('findSourceById returns null for a non-existent UUID', () => {
			if (!pgAvailable) return;

			const { stdout, stderr } = runScript(`
				import { findSourceById, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const found = await findSourceById(pool, '00000000-0000-0000-0000-000000000000');
					process.stderr.write('RESULT:' + JSON.stringify(found) + '\\n');
					process.stderr.write('IS_NULL:' + (found === null) + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('IS_NULL:true');
		});
	});

	// ─── QA-05: Find source by hash works ───

	describe('QA-05: Find source by hash works', () => {
		it('findSourceByHash returns the correct source for a known hash', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const uniqueHash = `hash_qa05_${Date.now()}`;

			const { stdout, stderr } = runScript(`
				import { createSource, findSourceByHash, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const created = await createSource(pool, {
						filename: 'hash-lookup.pdf',
						storagePath: 'raw/hash-lookup.pdf',
						fileHash: '${uniqueHash}',
					});

					const found = await findSourceByHash(pool, '${uniqueHash}');

					process.stderr.write('FOUND:' + (found !== null) + '\\n');
					process.stderr.write('ID_MATCH:' + (found.id === created.id) + '\\n');
					process.stderr.write('HASH_MATCH:' + (found.fileHash === '${uniqueHash}') + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('FOUND:true');
			expect(combined).toContain('ID_MATCH:true');
			expect(combined).toContain('HASH_MATCH:true');
		});
	});

	// ─── QA-06: Update source status transitions correctly ───

	describe('QA-06: Update source status transitions correctly', () => {
		it('updateSourceStatus changes status and refreshes updated_at', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, updateSourceStatus, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const created = await createSource(pool, {
						filename: 'status-test.pdf',
						storagePath: 'raw/status-test.pdf',
						fileHash: 'hash_qa06_' + Date.now(),
					});

					process.stderr.write('INITIAL_STATUS:' + created.status + '\\n');

					// Small delay to ensure updated_at differs
					await new Promise(r => setTimeout(r, 50));

					const updated = await updateSourceStatus(pool, created.id, 'extracted');

					process.stderr.write('NEW_STATUS:' + updated.status + '\\n');
					process.stderr.write('UPDATED_AT_REFRESHED:' + (updated.updatedAt > created.updatedAt) + '\\n');
					process.stderr.write('SAME_ID:' + (updated.id === created.id) + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('INITIAL_STATUS:ingested');
			expect(combined).toContain('NEW_STATUS:extracted');
			expect(combined).toContain('UPDATED_AT_REFRESHED:true');
			expect(combined).toContain('SAME_ID:true');
		});
	});

	// ─── QA-07: Update source partial fields ───

	describe('QA-07: Update source partial fields', () => {
		it('updateSource changes only provided fields, others remain untouched', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, updateSource, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const created = await createSource(pool, {
						filename: 'partial-update.pdf',
						storagePath: 'raw/partial-update.pdf',
						fileHash: 'hash_qa07_' + Date.now(),
						pageCount: 1,
						tags: ['original'],
					});

					const updated = await updateSource(pool, created.id, {
						pageCount: 42,
						hasNativeText: true,
					});

					process.stderr.write('PAGE_COUNT:' + updated.pageCount + '\\n');
					process.stderr.write('HAS_NATIVE_TEXT:' + updated.hasNativeText + '\\n');
					// These should remain unchanged
					process.stderr.write('FILENAME:' + updated.filename + '\\n');
					process.stderr.write('STORAGE_PATH:' + updated.storagePath + '\\n');
					process.stderr.write('TAGS:' + JSON.stringify(updated.tags) + '\\n');
					process.stderr.write('STATUS:' + updated.status + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('PAGE_COUNT:42');
			expect(combined).toContain('HAS_NATIVE_TEXT:true');
			// Untouched fields
			expect(combined).toContain('FILENAME:partial-update.pdf');
			expect(combined).toContain('STORAGE_PATH:raw/partial-update.pdf');
			expect(combined).toContain('TAGS:["original"]');
			expect(combined).toContain('STATUS:ingested');
		});
	});

	// ─── QA-08: Delete source cascades to source_steps ───

	describe('QA-08: Delete source cascades to source_steps', () => {
		it('deleteSource removes source and its source_steps', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, upsertSourceStep, deleteSource, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const source = await createSource(pool, {
						filename: 'delete-test.pdf',
						storagePath: 'raw/delete-test.pdf',
						fileHash: 'hash_qa08_' + Date.now(),
					});

					// Create associated source steps
					await upsertSourceStep(pool, {
						sourceId: source.id,
						stepName: 'extract',
						status: 'completed',
						configHash: 'cfg1',
					});
					await upsertSourceStep(pool, {
						sourceId: source.id,
						stepName: 'segment',
						status: 'pending',
					});

					process.stderr.write('SOURCE_ID:' + source.id + '\\n');

					const deleted = await deleteSource(pool, source.id);
					process.stderr.write('DELETED:' + deleted + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('DELETED:true');

			// Extract source ID from output to verify via psql
			const idMatch = combined.match(/SOURCE_ID:([a-f0-9-]+)/);
			expect(idMatch).not.toBeNull();
			const sourceId = idMatch?.[1];

			// Verify source is gone
			const sourceCount = runSql(`SELECT COUNT(*) FROM sources WHERE id = '${sourceId}';`);
			expect(sourceCount).toBe('0');

			// Verify source_steps are gone (cascade)
			const stepCount = runSql(`SELECT COUNT(*) FROM source_steps WHERE source_id = '${sourceId}';`);
			expect(stepCount).toBe('0');
		});
	});

	// ─── QA-09: Find all sources with status filter ───

	describe('QA-09: Find all sources with status filter', () => {
		it('findAllSources with status filter returns only matching sources', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, updateSourceStatus, findAllSources, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					// Create 3 sources: 2 ingested, 1 extracted
					const s1 = await createSource(pool, {
						filename: 'filter-1.pdf',
						storagePath: 'raw/filter-1.pdf',
						fileHash: 'hash_qa09_1_' + Date.now(),
					});
					const s2 = await createSource(pool, {
						filename: 'filter-2.pdf',
						storagePath: 'raw/filter-2.pdf',
						fileHash: 'hash_qa09_2_' + Date.now(),
					});
					const s3 = await createSource(pool, {
						filename: 'filter-3.pdf',
						storagePath: 'raw/filter-3.pdf',
						fileHash: 'hash_qa09_3_' + Date.now(),
					});

					// Update one to extracted
					await updateSourceStatus(pool, s3.id, 'extracted');

					const ingested = await findAllSources(pool, { status: 'ingested' });
					const extracted = await findAllSources(pool, { status: 'extracted' });

					process.stderr.write('INGESTED_COUNT:' + ingested.length + '\\n');
					process.stderr.write('EXTRACTED_COUNT:' + extracted.length + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('INGESTED_COUNT:2');
			expect(combined).toContain('EXTRACTED_COUNT:1');
		});
	});

	// ─── QA-10: Upsert source step creates and updates ───

	describe('QA-10: Upsert source step creates and updates', () => {
		it('upsertSourceStep creates on first call, updates on second, only one row exists', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, upsertSourceStep, findSourceStep, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const source = await createSource(pool, {
						filename: 'upsert-step.pdf',
						storagePath: 'raw/upsert-step.pdf',
						fileHash: 'hash_qa10_' + Date.now(),
					});

					// First upsert: creates
					const step1 = await upsertSourceStep(pool, {
						sourceId: source.id,
						stepName: 'extract',
						status: 'pending',
					});
					process.stderr.write('FIRST_STATUS:' + step1.status + '\\n');

					// Second upsert: updates
					const step2 = await upsertSourceStep(pool, {
						sourceId: source.id,
						stepName: 'extract',
						status: 'completed',
						configHash: 'cfg_abc',
					});
					process.stderr.write('SECOND_STATUS:' + step2.status + '\\n');
					process.stderr.write('SOURCE_ID:' + source.id + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('FIRST_STATUS:pending');
			expect(combined).toContain('SECOND_STATUS:completed');

			// Verify only one row exists via psql
			const idMatch = combined.match(/SOURCE_ID:([a-f0-9-]+)/);
			expect(idMatch).not.toBeNull();
			const sourceId = idMatch?.[1];

			const stepCount = runSql(
				`SELECT COUNT(*) FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'extract';`,
			);
			expect(stepCount).toBe('1');

			// Verify it has the latest status
			const stepStatus = runSql(
				`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'extract';`,
			);
			expect(stepStatus).toBe('completed');
		});
	});

	// ─── QA-11: Find source steps returns all steps ───

	describe('QA-11: Find source steps returns all steps', () => {
		it('findSourceSteps returns all 3 steps for a source', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, upsertSourceStep, findSourceSteps, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const source = await createSource(pool, {
						filename: 'find-steps.pdf',
						storagePath: 'raw/find-steps.pdf',
						fileHash: 'hash_qa11_' + Date.now(),
					});

					await upsertSourceStep(pool, { sourceId: source.id, stepName: 'extract', status: 'completed' });
					await upsertSourceStep(pool, { sourceId: source.id, stepName: 'segment', status: 'pending' });
					await upsertSourceStep(pool, { sourceId: source.id, stepName: 'enrich', status: 'failed', errorMessage: 'timeout' });

					const steps = await findSourceSteps(pool, source.id);

					process.stderr.write('STEP_COUNT:' + steps.length + '\\n');
					for (const step of steps) {
						process.stderr.write('STEP:' + step.stepName + ':' + step.status + '\\n');
					}
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('STEP_COUNT:3');
			expect(combined).toContain('STEP:extract:completed');
			expect(combined).toContain('STEP:segment:pending');
			expect(combined).toContain('STEP:enrich:failed');
		});
	});

	// ─── QA-12: Count sources respects filter ───

	describe('QA-12: Count sources respects filter', () => {
		it('countSources with status filter returns correct count', () => {
			if (!pgAvailable) return;

			cleanSourceData();

			const { stdout, stderr } = runScript(`
				import { createSource, updateSourceStatus, countSources, closeAllPools, getWorkerPool } from '${DB_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					// Create 5 sources: 3 ingested, 2 extracted
					const ts = Date.now();
					for (let i = 0; i < 3; i++) {
						await createSource(pool, {
							filename: 'count-i-' + i + '.pdf',
							storagePath: 'raw/count-i-' + i + '.pdf',
							fileHash: 'hash_qa12_i_' + i + '_' + ts,
						});
					}
					for (let i = 0; i < 2; i++) {
						const s = await createSource(pool, {
							filename: 'count-e-' + i + '.pdf',
							storagePath: 'raw/count-e-' + i + '.pdf',
							fileHash: 'hash_qa12_e_' + i + '_' + ts,
						});
						await updateSourceStatus(pool, s.id, 'extracted');
					}

					const ingestedCount = await countSources(pool, { status: 'ingested' });
					const extractedCount = await countSources(pool, { status: 'extracted' });
					const totalCount = await countSources(pool);

					process.stderr.write('INGESTED:' + ingestedCount + '\\n');
					process.stderr.write('EXTRACTED:' + extractedCount + '\\n');
					process.stderr.write('TOTAL:' + totalCount + '\\n');
				} catch (e) {
					process.stderr.write('ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).not.toContain('ERROR:');
			expect(combined).toContain('INGESTED:3');
			expect(combined).toContain('EXTRACTED:2');
			expect(combined).toContain('TOTAL:5');
		});
	});

	// ─── QA-13: Build compiles without errors ───

	describe('QA-13: Build compiles without errors', () => {
		it('pnpm turbo run build succeeds with zero TypeScript errors', () => {
			const result = spawnSync('pnpm', ['turbo', 'run', 'build'], {
				cwd: ROOT,
				encoding: 'utf-8',
				timeout: 120000,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env },
			});

			const combined = (result.stdout ?? '') + (result.stderr ?? '');
			expect(result.status).toBe(0);
			// Should not contain TS errors
			expect(combined).not.toMatch(/error TS\d+/);
		});
	});

	// ─── QA-14: Biome lint passes ───

	describe('QA-14: Biome lint passes', () => {
		it('npx biome check . reports no lint or format violations', () => {
			const result = spawnSync('npx', ['biome', 'check', '.'], {
				cwd: ROOT,
				encoding: 'utf-8',
				timeout: 60000,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env },
			});

			expect(result.status).toBe(0);
		});
	});
});
