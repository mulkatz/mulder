import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const VALID_LOCATION_ID = '00000000-0000-0000-0000-000000660001';
const INVALID_COORDINATE_ID = '00000000-0000-0000-0000-000000660002';
const INVALID_DATE_ID = '00000000-0000-0000-0000-000000660003';
const LOW_CONFIDENCE_ID = '00000000-0000-0000-0000-000000660004';

let tmpDir: string;
let defaultConfigPath: string;
let strictConfigPath: string;
const pgAvailable = db.isPgAvailable();
const describeIfPg = pgAvailable ? describe : describe.skip;

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function jsonLiteral(value: Record<string, unknown>): string {
	return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function writeGroundingConfig(minConfidence = 0.7): string {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const replacement = [
		'grounding:',
		'  enabled: true',
		'  mode: "on_demand"',
		'  enrich_types: ["location", "person", "organization"]',
		'  cache_ttl_days: 30',
		`  min_confidence: ${minConfidence}`,
		'  exclude_domains: ["reddit.com"]',
		'',
		'# --- Analysis (v2.0) ---',
	].join('\n');

	const updated = base.replace(/grounding:\n[\s\S]*?\n# --- Analysis \(v2\.0\) ---/, replacement);
	const configPath = join(tmpDir, `grounding-66-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
	writeFileSync(configPath, updated, 'utf-8');
	return configPath;
}

function cleanTestData(): void {
	db.runSql(
		[
			'DELETE FROM entity_grounding',
			'DELETE FROM story_entities',
			'DELETE FROM entity_edges',
			'DELETE FROM entity_aliases',
			'DELETE FROM entities',
			'DELETE FROM stories',
			'DELETE FROM source_steps',
			'DELETE FROM sources',
		].join('; '),
	);
}

function seedEntity(args: { id: string; name: string; type: string; attributes?: Record<string, unknown> }): void {
	db.runSql(
		[
			'INSERT INTO entities (id, name, type, attributes, taxonomy_status)',
			`VALUES (${sqlString(args.id)}, ${sqlString(args.name)}, ${sqlString(args.type)}, ${jsonLiteral(args.attributes ?? {})}, 'auto')`,
		].join(' '),
	);
}

function seedFixtureEntities(): void {
	seedEntity({ id: VALID_LOCATION_ID, name: 'Berlin', type: 'location' });
	seedEntity({ id: INVALID_COORDINATE_ID, name: 'Invalid Coordinate Plaza', type: 'location' });
	seedEntity({ id: INVALID_DATE_ID, name: 'Invalid Date Person', type: 'person' });
	seedEntity({ id: LOW_CONFIDENCE_ID, name: 'Alice Adler', type: 'person' });
}

function groundingCount(entityId: string): number {
	return Number.parseInt(
		db.runSql(`SELECT COUNT(*) FROM entity_grounding WHERE entity_id = ${sqlString(entityId)};`),
		10,
	);
}

function geomText(entityId: string): string | null {
	const value = db.runSqlSafe(`SELECT ST_AsText(geom) FROM entities WHERE id = ${sqlString(entityId)};`);
	return value === '' ? null : value;
}

function entityAttributes(entityId: string): Record<string, unknown> {
	const raw = db.runSql(`SELECT attributes::text FROM entities WHERE id = ${sqlString(entityId)};`);
	return JSON.parse(raw);
}

if (!pgAvailable) {
	console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
}

describeIfPg('Spec 66 — Ground Plausibility Validation Before Persistence', () => {
	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-66-'));
		defaultConfigPath = writeGroundingConfig(0.7);
		strictConfigPath = writeGroundingConfig(0.95);

		const migrate = runCli(['db', 'migrate', defaultConfigPath], {
			env: { MULDER_CONFIG: defaultConfigPath },
			timeout: 120_000,
		});
		if (migrate.exitCode !== 0) {
			throw new Error(`Migration failed: ${migrate.stdout} ${migrate.stderr}`);
		}

		cleanTestData();
	}, 180_000);

	beforeEach(() => {
		cleanTestData();
	});

	afterAll(() => {
		cleanTestData();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('QA-01: valid location grounding still persists coordinates and cache data', () => {
		seedFixtureEntities();

		const result = runCli(['ground', VALID_LOCATION_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('grounded');
		expect(groundingCount(VALID_LOCATION_ID)).toBe(1);
		expect(geomText(VALID_LOCATION_ID)).toContain('POINT');
	});

	it('QA-02: invalid grounded coordinates are rejected without writes', () => {
		seedFixtureEntities();
		expect(geomText(INVALID_COORDINATE_ID)).toBeNull();

		const result = runCli(['ground', INVALID_COORDINATE_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_VALIDATION_FAILED');
		expect(groundingCount(INVALID_COORDINATE_ID)).toBe(0);
		expect(geomText(INVALID_COORDINATE_ID)).toBeNull();
	});

	it('QA-03: implausible grounded date attributes are rejected without writes', () => {
		seedFixtureEntities();

		const result = runCli(['ground', INVALID_DATE_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_VALIDATION_FAILED');
		expect(groundingCount(INVALID_DATE_ID)).toBe(0);
		expect(entityAttributes(INVALID_DATE_ID).iso_date).toBeUndefined();
		expect(entityAttributes(INVALID_DATE_ID).verified_date).toBeUndefined();
	});

	it('QA-04: existing low-confidence rejection still wins before persistence', () => {
		seedFixtureEntities();

		const result = runCli(['ground', LOW_CONFIDENCE_ID], { env: { MULDER_CONFIG: strictConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_VALIDATION_FAILED');
		expect(groundingCount(LOW_CONFIDENCE_ID)).toBe(0);
	});

	it('CLI-01: <valid-location-id> exits 0, persists one grounding row, and applies geometry', () => {
		seedFixtureEntities();

		const result = runCli(['ground', VALID_LOCATION_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(VALID_LOCATION_ID);
		expect(groundingCount(VALID_LOCATION_ID)).toBe(1);
		expect(geomText(VALID_LOCATION_ID)).toContain('POINT');
	});

	it('CLI-02: <invalid-coordinates-id> exits non-zero and leaves geometry unchanged', () => {
		seedFixtureEntities();

		const result = runCli(['ground', INVALID_COORDINATE_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_VALIDATION_FAILED');
		expect(groundingCount(INVALID_COORDINATE_ID)).toBe(0);
		expect(geomText(INVALID_COORDINATE_ID)).toBeNull();
	});

	it('CLI-03: <invalid-date-id> exits non-zero and leaves invalid grounded date absent', () => {
		seedFixtureEntities();

		const result = runCli(['ground', INVALID_DATE_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_VALIDATION_FAILED');
		expect(groundingCount(INVALID_DATE_ID)).toBe(0);
		expect(entityAttributes(INVALID_DATE_ID).iso_date).toBeUndefined();
	});

	it('CLI-04: <low-confidence-id> exits non-zero and persists no grounding row', () => {
		seedFixtureEntities();

		const result = runCli(['ground', LOW_CONFIDENCE_ID], { env: { MULDER_CONFIG: strictConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_VALIDATION_FAILED');
		expect(groundingCount(LOW_CONFIDENCE_ID)).toBe(0);
	});
});
