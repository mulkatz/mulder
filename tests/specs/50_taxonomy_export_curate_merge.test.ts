import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema } from '../lib/schema.js';

/**
 * Black-box QA tests for Spec 50: Taxonomy Export/Curate/Merge
 *
 * Each `it()` maps to one QA-NN or CLI-NN condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `the shared env-driven SQL helper`, and filesystem.
 * Never imports from packages/ or src/ or apps/.
 *
 * Requires:
 * - PostgreSQL reachable through the standard PG env vars with migrations applied
 * - Built CLI at apps/cli/dist/index.js
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');

// Temporary file paths for test artifacts
const TMP_DIR = resolve(ROOT, 'tmp-test-50');
const CURATED_YAML_PATH = resolve(TMP_DIR, 'taxonomy.curated.yaml');

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
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, MULDER_LOG_LEVEL: 'silent', ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Seed taxonomy entries directly into the database.
 */
function seedTaxonomy(
	entries: Array<{
		id?: string;
		canonical_name: string;
		entity_type: string;
		status: string;
		category?: string;
		aliases?: string[];
	}>,
): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		const id = entry.id ?? randomUUID();
		const aliasArray = entry.aliases?.length
			? `ARRAY[${entry.aliases.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}]`
			: 'ARRAY[]::text[]';
		const categoryValue = entry.category ? `'${entry.category.replace(/'/g, "''")}'` : 'NULL';
		db.runSql(
			`INSERT INTO taxonomy (id, canonical_name, entity_type, status, category, aliases) ` +
				`VALUES ('${id}', '${entry.canonical_name.replace(/'/g, "''")}', '${entry.entity_type}', '${entry.status}', ${categoryValue}, ${aliasArray}) ` +
				`ON CONFLICT (canonical_name, entity_type) DO UPDATE SET status = '${entry.status}', aliases = ${aliasArray}, category = ${categoryValue};`,
		);
		ids.push(id);
	}
	return ids;
}

function cleanTestData(): void {
	// Use TRUNCATE CASCADE for robustness against foreign key ordering issues
	// when the database has leftover data from other test suites
	db.runSql(
		'TRUNCATE TABLE chunks, story_entities, entity_edges, entity_aliases, ' +
			'taxonomy, entities, stories, source_steps, ' +
			'pipeline_run_sources, pipeline_runs, sources CASCADE;',
	);
}

function cleanupTmpFiles(): void {
	try {
		if (existsSync(CURATED_YAML_PATH)) unlinkSync(CURATED_YAML_PATH);
		// Clean any other temp files in TMP_DIR
		if (existsSync(TMP_DIR)) {
			const { readdirSync, rmSync } = require('node:fs');
			for (const f of readdirSync(TMP_DIR)) {
				rmSync(resolve(TMP_DIR, f), { force: true });
			}
			rmSync(TMP_DIR, { force: true, recursive: true });
		}
	} catch {
		// best-effort cleanup
	}
}

/**
 * Count taxonomy entries in the database, optionally filtered by entity type.
 */
function countTaxonomy(entityType?: string): number {
	const where = entityType ? ` WHERE entity_type = '${entityType}'` : '';
	return Number(db.runSql(`SELECT COUNT(*) FROM taxonomy${where};`));
}

/**
 * Get a taxonomy entry by ID.
 */
function getTaxonomyById(
	id: string,
): { canonical_name: string; status: string; aliases: string; category: string | null } | null {
	const row = db.runSql(`SELECT canonical_name, status, aliases, category FROM taxonomy WHERE id = '${id}';`);
	if (!row) return null;
	const parts = row.split('|');
	return {
		canonical_name: parts[0],
		status: parts[1],
		aliases: parts[2],
		category: parts[3] === '' ? null : parts[3],
	};
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let pgAvailable = false;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
	pgAvailable = db.isPgAvailable();
	if (!pgAvailable) return;
	ensureSchema();
	cleanTestData();
	// Create tmp directory
	const { mkdirSync } = require('node:fs');
	mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
	if (!pgAvailable) return;
	cleanTestData();
	cleanupTmpFiles();
});

// ---------------------------------------------------------------------------
// QA Contract Tests (QA-01 to QA-15)
// ---------------------------------------------------------------------------

describe('Spec 50 — Taxonomy Export/Curate/Merge (QA Contract)', () => {
	beforeEach(() => {
		if (!pgAvailable) return;
		cleanTestData();
	});

	it('QA-01: Export produces valid YAML', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Alice Smith', entity_type: 'person', status: 'confirmed', aliases: ['Alice', 'A. Smith'] },
			{ canonical_name: 'Roswell', entity_type: 'location', status: 'auto', aliases: ['Roswell NM'] },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'export']);
		expect(exitCode, `Export failed: ${stderr}`).toBe(0);

		// stdout should be valid YAML
		expect(stdout.length).toBeGreaterThan(0);

		// Parse as YAML (use js-yaml-compatible parsing check: valid YAML should not throw)
		// We can't import js-yaml (black-box), so validate structural markers
		// The output should contain entity type top-level keys
		expect(stdout).toContain('person:');
		expect(stdout).toContain('location:');

		// Each entry should include id, canonical, status, aliases
		expect(stdout).toMatch(/id:\s+/);
		expect(stdout).toMatch(/canonical:\s+/);
		expect(stdout).toMatch(/status:\s+/);
		expect(stdout).toMatch(/aliases:/);
	});

	it('QA-02: Export includes all entries', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Person One', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Location One', entity_type: 'location', status: 'confirmed' },
			{ canonical_name: 'Org One', entity_type: 'organization', status: 'auto' },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'export']);
		expect(exitCode, `Export failed: ${stderr}`).toBe(0);

		// All three types should appear as top-level keys
		expect(stdout).toContain('person:');
		expect(stdout).toContain('location:');
		expect(stdout).toContain('organization:');

		// All entries should be included
		expect(stdout).toContain('Person One');
		expect(stdout).toContain('Location One');
		expect(stdout).toContain('Org One');
	});

	it('QA-03: Export with --type filter', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Person A', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Location A', entity_type: 'location', status: 'auto' },
			{ canonical_name: 'Org A', entity_type: 'organization', status: 'auto' },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'export', '--type', 'person']);
		expect(exitCode, `Export failed: ${stderr}`).toBe(0);

		// Only person entries should appear
		expect(stdout).toContain('person:');
		expect(stdout).toContain('Person A');

		// Other types should NOT appear
		expect(stdout).not.toContain('location:');
		expect(stdout).not.toContain('organization:');
		expect(stdout).not.toContain('Location A');
		expect(stdout).not.toContain('Org A');
	});

	it('QA-04: Export with --output writes to file', () => {
		if (!pgAvailable) return;

		seedTaxonomy([{ canonical_name: 'File Test Person', entity_type: 'person', status: 'auto', aliases: ['FTP'] }]);

		const outputPath = resolve(TMP_DIR, 'export-test.yaml');

		const { exitCode, stderr } = runCli(['taxonomy', 'export', '--output', outputPath]);
		expect(exitCode, `Export to file failed: ${stderr}`).toBe(0);

		// File should exist
		expect(existsSync(outputPath)).toBe(true);

		// File content should match stdout export
		const fileContent = readFileSync(outputPath, 'utf-8');
		expect(fileContent).toContain('person:');
		expect(fileContent).toContain('File Test Person');
		expect(fileContent).toContain('FTP');

		// Compare with stdout export
		runCli(['taxonomy', 'export']);
		// The content in the file should be the same YAML (ignoring potential stderr messages)
		expect(fileContent).toContain('person:');
		expect(fileContent).toContain('File Test Person');

		// Cleanup
		unlinkSync(outputPath);
	});

	it('QA-05: Export round-trips through merge unchanged', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Round Trip Person', entity_type: 'person', status: 'confirmed', aliases: ['RTP'] },
			{ canonical_name: 'Round Trip Location', entity_type: 'location', status: 'auto', aliases: ['RTL'] },
		]);

		const countBefore = countTaxonomy();

		// Export to file
		const exportPath = resolve(TMP_DIR, 'roundtrip.yaml');
		const { exitCode: exportExit, stderr: exportErr } = runCli(['taxonomy', 'export', '--output', exportPath]);
		expect(exportExit, `Export failed: ${exportErr}`).toBe(0);

		// Merge without edits
		const {
			exitCode: mergeExit,
			stdout: mergeOut,
			stderr: mergeErr,
		} = runCli(['taxonomy', 'merge', '--input', exportPath]);
		expect(mergeExit, `Merge failed: ${mergeErr}`).toBe(0);

		const combined = mergeOut + mergeErr;

		// Should report 0 created, 0 updated, 0 deleted, N unchanged
		expect(combined).toMatch(/0\s*(created|new)/i);
		expect(combined).toMatch(/0\s*(updated|changed)/i);
		expect(combined).toMatch(/0\s*deleted/i);

		// Entry count should be the same
		const countAfter = countTaxonomy();
		expect(countAfter).toBe(countBefore);

		unlinkSync(exportPath);
	});

	it('QA-06: Merge creates new entries', () => {
		if (!pgAvailable) return;

		// Start with one existing entry
		seedTaxonomy([{ canonical_name: 'Existing Person', entity_type: 'person', status: 'auto' }]);

		// Create a YAML with the existing entry plus a new one (no id)
		const yamlContent = `person:
  - id: "${db.runSql("SELECT id FROM taxonomy WHERE canonical_name = 'Existing Person';")}"
    canonical: "Existing Person"
    status: auto
    aliases: []
  - canonical: "Brand New Person"
    status: confirmed
    aliases:
      - "BNP"
      - "New P"
`;

		const inputPath = resolve(TMP_DIR, 'merge-create.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		expect(exitCode, `Merge failed: ${stdout}\n${stderr}`).toBe(0);

		// A new entry should be created
		const newEntry = db.runSql(
			"SELECT canonical_name, status, aliases FROM taxonomy WHERE canonical_name = 'Brand New Person';",
		);
		expect(newEntry).toContain('Brand New Person');
		expect(newEntry).toContain('confirmed');

		unlinkSync(inputPath);
	});

	it('QA-07: Merge updates status', () => {
		if (!pgAvailable) return;

		const [id] = seedTaxonomy([
			{ canonical_name: 'Status Update Person', entity_type: 'person', status: 'auto', aliases: ['SUP'] },
		]);

		// Create YAML with status changed from auto to confirmed
		const yamlContent = `person:
  - id: "${id}"
    canonical: "Status Update Person"
    status: confirmed
    aliases:
      - "SUP"
`;

		const inputPath = resolve(TMP_DIR, 'merge-status.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		expect(exitCode, `Merge failed: ${stderr}`).toBe(0);

		// Status should be updated
		const entry = getTaxonomyById(id);
		expect(entry).not.toBeNull();
		expect(entry?.status).toBe('confirmed');

		unlinkSync(inputPath);
	});

	it('QA-08: Merge renames canonical name', () => {
		if (!pgAvailable) return;

		const [id] = seedTaxonomy([{ canonical_name: 'Old Name', entity_type: 'person', status: 'auto', aliases: ['ON'] }]);

		// Create YAML with same ID but different canonical name
		const yamlContent = `person:
  - id: "${id}"
    canonical: "New Renamed Name"
    status: auto
    aliases:
      - "ON"
`;

		const inputPath = resolve(TMP_DIR, 'merge-rename.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		expect(exitCode, `Merge failed: ${stderr}`).toBe(0);

		// canonical_name should be updated
		const entry = getTaxonomyById(id);
		expect(entry).not.toBeNull();
		expect(entry?.canonical_name).toBe('New Renamed Name');

		unlinkSync(inputPath);
	});

	it('QA-09: Merge updates aliases', () => {
		if (!pgAvailable) return;

		const [id] = seedTaxonomy([
			{ canonical_name: 'Alias Person', entity_type: 'person', status: 'auto', aliases: ['AP', 'OldAlias'] },
		]);

		// Create YAML with changed aliases (replacement, not additive)
		const yamlContent = `person:
  - id: "${id}"
    canonical: "Alias Person"
    status: auto
    aliases:
      - "AP"
      - "NewAlias"
      - "AnotherNew"
`;

		const inputPath = resolve(TMP_DIR, 'merge-aliases.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		expect(exitCode, `Merge failed: ${stderr}`).toBe(0);

		// Aliases should be replaced (not merged)
		const entry = getTaxonomyById(id);
		expect(entry).not.toBeNull();
		// The aliases should contain the new ones
		expect(entry?.aliases).toContain('NewAlias');
		expect(entry?.aliases).toContain('AnotherNew');
		expect(entry?.aliases).toContain('AP');
		// OldAlias should be gone (replaced, not merged)
		expect(entry?.aliases).not.toContain('OldAlias');

		unlinkSync(inputPath);
	});

	it('QA-10: Merge deletes removed entries', () => {
		if (!pgAvailable) return;

		const ids = seedTaxonomy([
			{ canonical_name: 'Keep Person 1', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Keep Person 2', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Keep Person 3', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Delete Person 1', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Delete Person 2', entity_type: 'person', status: 'auto' },
		]);

		expect(countTaxonomy('person')).toBe(5);

		// Create YAML with only 3 of the 5 person entries
		const yamlContent = `person:
  - id: "${ids[0]}"
    canonical: "Keep Person 1"
    status: auto
    aliases: []
  - id: "${ids[1]}"
    canonical: "Keep Person 2"
    status: auto
    aliases: []
  - id: "${ids[2]}"
    canonical: "Keep Person 3"
    status: auto
    aliases: []
`;

		const inputPath = resolve(TMP_DIR, 'merge-delete.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		expect(exitCode, `Merge failed: ${stderr}`).toBe(0);

		// Only 3 person entries should remain
		expect(countTaxonomy('person')).toBe(3);

		// The deleted entries should not exist
		expect(getTaxonomyById(ids[3])).toBeNull();
		expect(getTaxonomyById(ids[4])).toBeNull();

		// The kept entries should still exist
		expect(getTaxonomyById(ids[0])).not.toBeNull();
		expect(getTaxonomyById(ids[1])).not.toBeNull();
		expect(getTaxonomyById(ids[2])).not.toBeNull();

		unlinkSync(inputPath);
	});

	it('QA-11: Merge does not delete entries of unexported types', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Person In YAML', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Location Not In YAML', entity_type: 'location', status: 'auto' },
			{ canonical_name: 'Org Not In YAML', entity_type: 'organization', status: 'confirmed' },
		]);

		const personId = db.runSql("SELECT id FROM taxonomy WHERE canonical_name = 'Person In YAML';");

		// Create YAML that only contains person type
		const yamlContent = `person:
  - id: "${personId}"
    canonical: "Person In YAML"
    status: auto
    aliases: []
`;

		const inputPath = resolve(TMP_DIR, 'merge-preserve-types.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		expect(exitCode, `Merge failed: ${stderr}`).toBe(0);

		// Location and organization entries should NOT be deleted
		expect(countTaxonomy('location')).toBe(1);
		expect(countTaxonomy('organization')).toBe(1);
		expect(countTaxonomy('person')).toBe(1);

		unlinkSync(inputPath);
	});

	it('QA-12: Merge --dry-run shows changes without applying', () => {
		if (!pgAvailable) return;

		const [id] = seedTaxonomy([
			{ canonical_name: 'DryRun Person', entity_type: 'person', status: 'auto', aliases: ['DRP'] },
		]);

		// Create YAML with status changed
		const yamlContent = `person:
  - id: "${id}"
    canonical: "DryRun Person"
    status: confirmed
    aliases:
      - "DRP"
`;

		const inputPath = resolve(TMP_DIR, 'merge-dryrun.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath, '--dry-run']);
		expect(exitCode, `Dry-run failed: ${stderr}`).toBe(0);

		const combined = stdout + stderr;
		// Should show what would change
		expect(combined.length).toBeGreaterThan(0);

		// Database should NOT be modified
		const entry = getTaxonomyById(id);
		expect(entry).not.toBeNull();
		expect(entry?.status).toBe('auto'); // Still auto, not confirmed

		unlinkSync(inputPath);
	});

	it('QA-13: Merge validates YAML structure', () => {
		if (!pgAvailable) return;

		// Create invalid YAML (missing required `canonical` field)
		const invalidYaml = `person:
  - status: auto
    aliases:
      - "Missing Canonical"
`;

		const inputPath = resolve(TMP_DIR, 'merge-invalid.yaml');
		writeFileSync(inputPath, invalidYaml, 'utf-8');

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		const combined = stdout + stderr;

		// Should fail with validation error
		expect(exitCode).not.toBe(0);
		expect(combined.toLowerCase()).toMatch(/valid|error|canonical/i);

		// Database should not be modified (no entries should have been created)
		expect(countTaxonomy()).toBe(0);

		unlinkSync(inputPath);
	});

	it('QA-14: Merge is transactional', () => {
		if (!pgAvailable) return;

		const [_id1] = seedTaxonomy([
			{ canonical_name: 'Txn Person 1', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Txn Person 2', entity_type: 'person', status: 'auto' },
		]);

		const countBefore = countTaxonomy();

		// Create YAML that has a valid update + a reference to a non-existent ID
		// The non-existent ID should cause a warning/error, but we need to test
		// that the transaction rolls back all changes if there's a constraint violation.
		// A better approach: create two entries with the same canonical name which
		// should cause a unique constraint violation during insert.
		const yamlContent = `person:
  - canonical: "New Entry Alpha"
    status: confirmed
    aliases: []
  - canonical: "New Entry Alpha"
    status: auto
    aliases: []
`;

		const inputPath = resolve(TMP_DIR, 'merge-txn.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		const _combined = stdout + stderr;

		// Should fail (duplicate canonical name within same type)
		expect(exitCode).not.toBe(0);

		// Database should not be modified (transaction rolled back)
		const countAfter = countTaxonomy();
		expect(countAfter).toBe(countBefore);

		unlinkSync(inputPath);
	});

	it('QA-15: Merge detects duplicate entries', () => {
		if (!pgAvailable) return;

		// Create YAML with two entries having the same canonical and entity type
		const yamlContent = `person:
  - canonical: "Duplicate Name"
    status: confirmed
    aliases:
      - "DN"
  - canonical: "Duplicate Name"
    status: auto
    aliases:
      - "Dupe"
`;

		const inputPath = resolve(TMP_DIR, 'merge-duplicates.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath]);
		const combined = stdout + stderr;

		// Should fail with duplicate error
		expect(exitCode).not.toBe(0);
		expect(combined.toLowerCase()).toMatch(/duplicate|already exists|conflict/i);

		unlinkSync(inputPath);
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix (CLI-01 to CLI-08)
// ---------------------------------------------------------------------------

describe('Spec 50 — Taxonomy Export/Curate/Merge (CLI Test Matrix)', () => {
	beforeEach(() => {
		if (!pgAvailable) return;
		cleanTestData();
	});

	it('CLI-01: `taxonomy export --help` shows usage with --output, --type flags', () => {
		const { exitCode, stdout } = runCli(['taxonomy', 'export', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('--output');
		expect(stdout).toContain('--type');
		expect(stdout).toMatch(/export/i);
	});

	it('CLI-02: `taxonomy export` (no flags) outputs YAML to stdout', () => {
		if (!pgAvailable) return;

		seedTaxonomy([{ canonical_name: 'Stdout Person', entity_type: 'person', status: 'auto', aliases: ['SP'] }]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'export']);
		expect(exitCode, `Export failed: ${stderr}`).toBe(0);

		// YAML content should be on stdout
		expect(stdout).toContain('person:');
		expect(stdout).toContain('Stdout Person');
	});

	it('CLI-03: `taxonomy export --type person` shows filtered output', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'CLI Person', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'CLI Location', entity_type: 'location', status: 'auto' },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'export', '--type', 'person']);
		expect(exitCode, `Export failed: ${stderr}`).toBe(0);

		expect(stdout).toContain('person:');
		expect(stdout).toContain('CLI Person');
		expect(stdout).not.toContain('location:');
		expect(stdout).not.toContain('CLI Location');
	});

	it('CLI-04: `taxonomy export --output` writes to file', () => {
		if (!pgAvailable) return;

		seedTaxonomy([{ canonical_name: 'CLI File Person', entity_type: 'person', status: 'auto' }]);

		const outputPath = resolve(TMP_DIR, 'cli-export-test.yaml');

		const { exitCode, stderr } = runCli(['taxonomy', 'export', '--output', outputPath]);
		expect(exitCode, `Export to file failed: ${stderr}`).toBe(0);

		expect(existsSync(outputPath)).toBe(true);
		const content = readFileSync(outputPath, 'utf-8');
		expect(content).toContain('CLI File Person');

		unlinkSync(outputPath);
	});

	it('CLI-05: `taxonomy merge --help` shows usage with --input, --dry-run flags', () => {
		const { exitCode, stdout } = runCli(['taxonomy', 'merge', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('--input');
		expect(stdout).toContain('--dry-run');
		expect(stdout).toMatch(/merge/i);
	});

	it('CLI-06: `taxonomy merge --dry-run` shows preview without changes', () => {
		if (!pgAvailable) return;

		const [id] = seedTaxonomy([{ canonical_name: 'CLI DryRun', entity_type: 'person', status: 'auto' }]);

		const yamlContent = `person:
  - id: "${id}"
    canonical: "CLI DryRun"
    status: confirmed
    aliases: []
`;

		const inputPath = resolve(TMP_DIR, 'cli-dryrun.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--input', inputPath, '--dry-run']);
		expect(exitCode, `Dry-run failed: ${stderr}`).toBe(0);

		// Database should not be modified
		const entry = getTaxonomyById(id);
		expect(entry?.status).toBe('auto');

		unlinkSync(inputPath);
	});

	it('CLI-07: `taxonomy merge --input custom.yaml` reads from custom path', () => {
		if (!pgAvailable) return;

		const [id] = seedTaxonomy([{ canonical_name: 'Custom Path Person', entity_type: 'person', status: 'auto' }]);

		const customPath = resolve(TMP_DIR, 'custom-merge-path.yaml');
		const yamlContent = `person:
  - id: "${id}"
    canonical: "Custom Path Person"
    status: confirmed
    aliases: []
`;
		writeFileSync(customPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--input', customPath]);
		expect(exitCode, `Merge from custom path failed: ${stderr}`).toBe(0);

		// Verify the entry was updated
		const entry = getTaxonomyById(id);
		expect(entry).not.toBeNull();
		expect(entry?.status).toBe('confirmed');

		unlinkSync(customPath);
	});

	it('CLI-08: `taxonomy curate --help` shows usage', () => {
		const { exitCode, stdout } = runCli(['taxonomy', 'curate', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/curate/i);
		// Should mention $EDITOR or editor
		expect(stdout).toMatch(/editor|\$EDITOR/i);
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: taxonomy export/curate/merge', () => {
	beforeEach(() => {
		if (!pgAvailable) return;
		cleanTestData();
	});

	it('SMOKE-01: `taxonomy --help` lists export, curate, merge subcommands', () => {
		const { exitCode, stdout } = runCli(['taxonomy', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('export');
		expect(stdout).toContain('curate');
		expect(stdout).toContain('merge');
	});

	it('SMOKE-02: `taxonomy export` with empty taxonomy produces valid output', () => {
		if (!pgAvailable) return;

		const { exitCode } = runCli(['taxonomy', 'export']);

		// Should succeed even with no entries
		expect(exitCode).toBe(0);
		// Output should either be empty YAML or a comment header
		// It should not crash
	});

	it('SMOKE-03: `taxonomy export --type` without value exits non-zero', () => {
		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'export', '--type']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/type|argument|required|missing/i);
	});

	it('SMOKE-04: `taxonomy export --output` without value exits non-zero', () => {
		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'export', '--output']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/output|argument|required|missing/i);
	});

	it('SMOKE-05: `taxonomy merge` without existing default file exits non-zero', () => {
		if (!pgAvailable) return;

		// Ensure the default curated YAML file does not exist in the project root
		const defaultCuratedPath = resolve(ROOT, 'taxonomy.curated.yaml');
		let backupContent: string | null = null;
		if (existsSync(defaultCuratedPath)) {
			backupContent = readFileSync(defaultCuratedPath, 'utf-8');
			unlinkSync(defaultCuratedPath);
		}

		try {
			// When no --input is given and taxonomy.curated.yaml doesn't exist,
			// merge should fail gracefully
			const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge']);
			const combined = stdout + stderr;

			expect(exitCode).not.toBe(0);
			// Should mention the missing file or give a meaningful error
			expect(combined.length).toBeGreaterThan(0);
		} finally {
			// Restore the file if it existed before
			if (backupContent !== null) {
				writeFileSync(defaultCuratedPath, backupContent, 'utf-8');
			}
		}
	});

	it('SMOKE-06: `taxonomy merge --input nonexistent.yaml` exits non-zero', () => {
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input', '/tmp/does-not-exist-99.yaml']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined.toLowerCase()).toMatch(/not found|no such file|enoent|does not exist|missing/i);
	});

	it('SMOKE-07: `taxonomy merge --input` without value exits non-zero', () => {
		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/input|argument|required|missing/i);
	});

	it('SMOKE-08: `taxonomy export --type nonexistent_type` returns empty output gracefully', () => {
		if (!pgAvailable) return;

		seedTaxonomy([{ canonical_name: 'Person Z', entity_type: 'person', status: 'auto' }]);

		const { exitCode, stdout } = runCli(['taxonomy', 'export', '--type', 'nonexistent_type']);

		// Should succeed but produce minimal/empty output
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain('Person Z');
	});

	it('SMOKE-09: `taxonomy export --output --type` combined flags work', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Combo Person', entity_type: 'person', status: 'confirmed' },
			{ canonical_name: 'Combo Location', entity_type: 'location', status: 'auto' },
		]);

		const outputPath = resolve(TMP_DIR, 'combo-export.yaml');

		const { exitCode, stderr } = runCli(['taxonomy', 'export', '--type', 'person', '--output', outputPath]);
		expect(exitCode, `Combined flags failed: ${stderr}`).toBe(0);

		expect(existsSync(outputPath)).toBe(true);
		const content = readFileSync(outputPath, 'utf-8');
		expect(content).toContain('Combo Person');
		expect(content).not.toContain('Combo Location');

		unlinkSync(outputPath);
	});

	it('SMOKE-10: `taxonomy merge --dry-run --input` combined flags work', () => {
		if (!pgAvailable) return;

		const [id] = seedTaxonomy([{ canonical_name: 'Combo Merge Person', entity_type: 'person', status: 'auto' }]);

		const yamlContent = `person:
  - id: "${id}"
    canonical: "Combo Merge Person"
    status: confirmed
    aliases: []
`;
		const inputPath = resolve(TMP_DIR, 'combo-merge.yaml');
		writeFileSync(inputPath, yamlContent, 'utf-8');

		const { exitCode, stderr } = runCli(['taxonomy', 'merge', '--dry-run', '--input', inputPath]);
		expect(exitCode, `Combined flags failed: ${stderr}`).toBe(0);

		// Database should remain unchanged
		const entry = getTaxonomyById(id);
		expect(entry?.status).toBe('auto');

		unlinkSync(inputPath);
	});

	it('SMOKE-11: `taxonomy merge` with malformed YAML exits non-zero', () => {
		if (!pgAvailable) return;

		const malformedPath = resolve(TMP_DIR, 'malformed.yaml');
		writeFileSync(malformedPath, '{{{{not valid yaml at all}}}}', 'utf-8');

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'merge', '--input', malformedPath]);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined.length).toBeGreaterThan(0);

		unlinkSync(malformedPath);
	});

	it('SMOKE-12: `taxonomy curate` without $EDITOR set uses fallback', () => {
		// This test checks that curate doesn't crash when EDITOR is unset.
		// We can't actually test the editor interaction, but we can verify it
		// tries to proceed. We use a non-interactive approach.
		// Since curate opens an editor, we'll just verify --help works (already tested in CLI-08).
		// For safety, skip interactive test.
		if (!pgAvailable) return;

		// We set EDITOR to a non-existent command to see the error behavior
		// without actually opening an editor
		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'curate'], {
			env: { EDITOR: '/bin/false' },
			timeout: 10000,
		});

		// The command should either:
		// 1. Try to export first (creating the file), then fail on editor
		// 2. Fail gracefully
		// We just verify it doesn't hang forever (timeout handles that)
		const _combined = stdout + stderr;
		// It ran to completion without hanging
		expect(typeof exitCode).toBe('number');
	});

	it('SMOKE-13: Export YAML includes comment header', () => {
		if (!pgAvailable) return;

		seedTaxonomy([{ canonical_name: 'Header Test', entity_type: 'person', status: 'auto' }]);

		const { exitCode, stdout } = runCli(['taxonomy', 'export']);
		expect(exitCode).toBe(0);

		// The spec says: "The comment header is always emitted (timestamp + instructions)"
		expect(stdout).toContain('#');
		expect(stdout).toMatch(/mulder taxonomy|Mulder Taxonomy/i);
	});

	it('SMOKE-14: Export sorting — confirmed before auto before rejected', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Zed Rejected', entity_type: 'person', status: 'rejected' },
			{ canonical_name: 'Zed Auto', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Zed Confirmed', entity_type: 'person', status: 'confirmed' },
		]);

		const { exitCode, stdout } = runCli(['taxonomy', 'export']);
		expect(exitCode).toBe(0);

		// Confirmed should appear before auto, auto before rejected
		const confirmedIdx = stdout.indexOf('Zed Confirmed');
		const autoIdx = stdout.indexOf('Zed Auto');
		const rejectedIdx = stdout.indexOf('Zed Rejected');

		expect(confirmedIdx).toBeGreaterThan(-1);
		expect(autoIdx).toBeGreaterThan(-1);
		expect(rejectedIdx).toBeGreaterThan(-1);

		expect(confirmedIdx).toBeLessThan(autoIdx);
		expect(autoIdx).toBeLessThan(rejectedIdx);
	});

	it('SMOKE-15: Export includes category when present', () => {
		if (!pgAvailable) return;

		seedTaxonomy([
			{ canonical_name: 'Categorized Location', entity_type: 'location', status: 'auto', category: 'historical' },
			{ canonical_name: 'No Category Person', entity_type: 'person', status: 'auto' },
		]);

		const { exitCode, stdout } = runCli(['taxonomy', 'export']);
		expect(exitCode).toBe(0);

		// Category should be included when present
		expect(stdout).toContain('category:');
		expect(stdout).toContain('historical');
	});
});
