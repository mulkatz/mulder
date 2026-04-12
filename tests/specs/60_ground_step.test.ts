import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const LOCATION_ID = '00000000-0000-0000-0000-000000600001';
const PERSON_ID = '00000000-0000-0000-0000-000000600002';
const ORG_ID = '00000000-0000-0000-0000-000000600003';
const ARTIFACT_ID = '00000000-0000-0000-0000-000000600004';

let tmpDir: string;
let pgAvailable = false;
let defaultConfigPath: string;
let strictConfigPath: string;

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

function writeGroundingConfig(opts?: { minConfidence?: number; excludeDomains?: string[] }): string {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const replacement = [
		'grounding:',
		'  enabled: true',
		'  mode: "on_demand"',
		'  enrich_types: ["location", "person", "organization"]',
		'  cache_ttl_days: 30',
		`  min_confidence: ${opts?.minConfidence ?? 0.7}`,
		`  exclude_domains: [${(opts?.excludeDomains ?? ['reddit.com']).map((domain) => `"${domain}"`).join(', ')}]`,
		'',
		'# --- Analysis (v2.0) ---',
	].join('\n');

	const updated = base.replace(/grounding:\n[\s\S]*?\n# --- Analysis \(v2\.0\) ---/, replacement);
	const configPath = join(tmpDir, `grounding-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
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
	const attributes = args.attributes ?? {};
	db.runSql(
		[
			'INSERT INTO entities (id, name, type, attributes, taxonomy_status)',
			`VALUES (${sqlString(args.id)}, ${sqlString(args.name)}, ${sqlString(args.type)}, ${jsonLiteral(attributes)}, 'auto')`,
		].join(' '),
	);
}

function seedGroundingFixtureSet(): void {
	seedEntity({
		id: LOCATION_ID,
		name: 'Berlin',
		type: 'location',
		attributes: {
			geo_point: { lat: 52.52, lng: 13.405 },
		},
	});
	seedEntity({ id: PERSON_ID, name: 'Alice Adler', type: 'person' });
	seedEntity({ id: ORG_ID, name: 'Mulder Research Group', type: 'organization' });
	seedEntity({ id: ARTIFACT_ID, name: 'Unknown Artifact', type: 'artifact' });
}

function groundingCount(entityId: string): number {
	return Number.parseInt(
		db.runSql(`SELECT COUNT(*) FROM entity_grounding WHERE entity_id = ${sqlString(entityId)};`),
		10,
	);
}

function groundingData(entityId: string): Record<string, unknown> {
	const raw = db.runSql(`SELECT grounding_data::text FROM entity_grounding WHERE entity_id = ${sqlString(entityId)};`);
	return JSON.parse(raw);
}

function groundedAt(entityId: string): string {
	return db.runSql(`SELECT grounded_at::text FROM entity_grounding WHERE entity_id = ${sqlString(entityId)};`);
}

function expiresAt(entityId: string): string {
	return db.runSql(`SELECT expires_at::text FROM entity_grounding WHERE entity_id = ${sqlString(entityId)};`);
}

function geomText(entityId: string): string | null {
	const value = db.runSqlSafe(`SELECT ST_AsText(geom) FROM entities WHERE id = ${sqlString(entityId)};`);
	return value === '' ? null : value;
}

describe('Spec 60 — Ground Step', () => {
	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-60-'));
		defaultConfigPath = writeGroundingConfig();
		strictConfigPath = writeGroundingConfig({ minConfidence: 0.95, excludeDomains: ['reddit.com', 'quora.com'] });

		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

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
		if (!pgAvailable) return;
		cleanTestData();
	});

	afterAll(() => {
		if (pgAvailable) {
			cleanTestData();
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('QA-01: mulder ground <entity-id> stores a cache row with URLs and expiry metadata', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		const result = runCli(['ground', LOCATION_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('grounded');
		expect(groundingCount(LOCATION_ID)).toBe(1);

		const data = groundingData(LOCATION_ID);
		expect(data.groundingMetadata).toBeTruthy();

		const sources = db.runSql(
			`SELECT array_length(source_urls, 1) FROM entity_grounding WHERE entity_id = ${sqlString(LOCATION_ID)};`,
		);
		expect(Number.parseInt(sources, 10)).toBeGreaterThanOrEqual(1);
		expect(new Date(expiresAt(LOCATION_ID)).getTime()).toBeGreaterThan(new Date(groundedAt(LOCATION_ID)).getTime());
	});

	it('QA-02: cached grounding is reused until TTL expiry', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		const first = runCli(['ground', PERSON_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(first.exitCode).toBe(0);
		const firstGroundedAt = groundedAt(PERSON_ID);

		const second = runCli(['ground', PERSON_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(second.exitCode).toBe(0);
		expect(second.stdout).toContain('cached');
		expect(groundedAt(PERSON_ID)).toBe(firstGroundedAt);
	});

	it('QA-03: --refresh bypasses the cache and replaces grounding data', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		const first = runCli(['ground', ORG_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(first.exitCode).toBe(0);
		const initialTimestamp = groundedAt(ORG_ID);

		db.runSql(
			`UPDATE entity_grounding SET grounded_at = now() - interval '2 days' WHERE entity_id = ${sqlString(ORG_ID)};`,
		);
		const refresh = runCli(['ground', ORG_ID, '--refresh'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(refresh.exitCode).toBe(0);
		expect(refresh.stdout).toContain('grounded');
		expect(groundedAt(ORG_ID)).not.toBe(initialTimestamp);
	});

	it('QA-04: type filters exclude entities outside configured or requested scope', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		const result = runCli(['ground', '--type', 'person'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(groundingCount(PERSON_ID)).toBe(1);
		expect(groundingCount(LOCATION_ID)).toBe(0);
		expect(groundingCount(ARTIFACT_ID)).toBe(0);
	});

	it('QA-05: grounded coordinates propagate to the entity record when a location is resolved', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		expect(geomText(LOCATION_ID)).toBeNull();

		const result = runCli(['ground', LOCATION_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(geomText(LOCATION_ID)).toContain('POINT');
	});

	it('QA-06: missing entity IDs fail cleanly without partial state', () => {
		if (!pgAvailable) return;

		const missing = '00000000-0000-0000-0000-000000609999';
		const result = runCli(['ground', missing], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_ENTITY_NOT_FOUND');
		expect(groundingCount(missing)).toBe(0);
	});

	it('QA-07: batch mode respects the requested batch size', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		const result = runCli(['ground', '--all', '--batch', '2'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(groundingCount(LOCATION_ID) + groundingCount(PERSON_ID) + groundingCount(ORG_ID)).toBe(2);
	});

	it('QA-08: low-confidence grounding is rejected', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		const result = runCli(['ground', PERSON_ID], { env: { MULDER_CONFIG: strictConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_VALIDATION_FAILED');
		expect(groundingCount(PERSON_ID)).toBe(0);
	});

	it('QA-09: excluded domains config is preserved in persisted grounding metadata', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		const result = runCli(['ground', LOCATION_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);

		const data = groundingData(LOCATION_ID);
		const metadata = data.groundingMetadata as Record<string, unknown>;
		expect(metadata.excludedDomains).toEqual(['reddit.com']);
		expect(metadata.groundingChunks).toBeTruthy();
	});

	it('QA-10: grounding writes are idempotent per entity', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();

		expect(runCli(['ground', LOCATION_ID], { env: { MULDER_CONFIG: defaultConfigPath } }).exitCode).toBe(0);
		expect(runCli(['ground', LOCATION_ID], { env: { MULDER_CONFIG: defaultConfigPath } }).exitCode).toBe(0);
		expect(groundingCount(LOCATION_ID)).toBe(1);
	});

	it('CLI-01: <entity-id> exits 0 and grounds a single eligible entity', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		const result = runCli(['ground', PERSON_ID], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(PERSON_ID);
	});

	it('CLI-02: <entity-id> --refresh exits 0 and bypasses cache', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		expect(runCli(['ground', PERSON_ID], { env: { MULDER_CONFIG: defaultConfigPath } }).exitCode).toBe(0);
		const result = runCli(['ground', PERSON_ID, '--refresh'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('grounded');
	});

	it('CLI-03: <entity-id> --batch 5 exits non-zero', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		const result = runCli(['ground', PERSON_ID, '--batch', '5'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('--batch is only valid');
	});

	it('CLI-04: <entity-id> --type location exits non-zero', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground', PERSON_ID, '--type', 'location'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('mutually exclusive');
	});

	it('CLI-05: <entity-id> --all exits non-zero', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground', PERSON_ID, '--all'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('mutually exclusive');
	});

	it('CLI-06: <missing-uuid> exits non-zero with a Ground-step error', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground', '00000000-0000-0000-0000-000000609998'], {
			env: { MULDER_CONFIG: defaultConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('GROUND_ENTITY_NOT_FOUND');
	});

	it('CLI-07: --all exits 0 and processes eligible entities up to the default batch size', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		const result = runCli(['ground', '--all'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('grounded');
	});

	it('CLI-08: --all --batch 2 exits 0 and processes at most 2 eligible entities', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		const result = runCli(['ground', '--all', '--batch', '2'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(groundingCount(LOCATION_ID) + groundingCount(PERSON_ID) + groundingCount(ORG_ID)).toBe(2);
	});

	it('CLI-09: --all --refresh exits 0 and refreshes cached entities', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		expect(runCli(['ground', '--all'], { env: { MULDER_CONFIG: defaultConfigPath } }).exitCode).toBe(0);
		const firstTimestamp = groundedAt(LOCATION_ID);
		const result = runCli(['ground', '--all', '--refresh'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(groundedAt(LOCATION_ID)).not.toBe(firstTimestamp);
	});

	it('CLI-10: --all --type person exits non-zero', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground', '--all', '--type', 'person'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('mutually exclusive');
	});

	it('CLI-11: --type location exits 0 and processes location entities only', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		const result = runCli(['ground', '--type', 'location'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(groundingCount(LOCATION_ID)).toBe(1);
		expect(groundingCount(PERSON_ID)).toBe(0);
	});

	it('CLI-12: --type location --batch 1 exits 0 and limits processing to 1 entity', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		seedEntity({ id: '00000000-0000-0000-0000-000000600005', name: 'Hamburg', type: 'location' });
		const result = runCli(['ground', '--type', 'location', '--batch', '1'], {
			env: { MULDER_CONFIG: defaultConfigPath },
		});
		expect(result.exitCode).toBe(0);
		expect(groundingCount(LOCATION_ID) + groundingCount('00000000-0000-0000-0000-000000600005')).toBe(1);
	});

	it('CLI-13: --type location --refresh exits 0', () => {
		if (!pgAvailable) return;
		seedGroundingFixtureSet();
		expect(runCli(['ground', '--type', 'location'], { env: { MULDER_CONFIG: defaultConfigPath } }).exitCode).toBe(0);
		const result = runCli(['ground', '--type', 'location', '--refresh'], {
			env: { MULDER_CONFIG: defaultConfigPath },
		});
		expect(result.exitCode).toBe(0);
	});

	it('CLI-14: --type location --all exits non-zero', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground', '--type', 'location', '--all'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('mutually exclusive');
	});

	it('CLI-15: --type "" exits non-zero with validation feedback', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground', '--type', ''], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('non-empty string');
	});

	it('CLI-16: no args exits non-zero with usage guidance', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('Provide an <entity-id>');
	});

	it('CLI-17: --batch 0 --all exits non-zero', () => {
		if (!pgAvailable) return;
		const result = runCli(['ground', '--all', '--batch', '0'], { env: { MULDER_CONFIG: defaultConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('positive integer');
	});
});
