import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema } from '../lib/schema.js';

/**
 * Black-box QA tests for Spec 46: Taxonomy Bootstrap
 *
 * Each `it()` maps to one QA-NN or CLI-NN condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `docker exec psql`, and filesystem.
 * Never imports from packages/ or src/ or apps/.
 *
 * Requires:
 * - Running PostgreSQL container `mulder-pg-test` with migrations applied
 * - Built CLI at apps/cli/dist/index.js
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

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
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, MULDER_LOG_LEVEL: 'silent', ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

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

/**
 * Parse JSON from CLI output, ignoring pino log lines that may precede it.
 */
function parseJsonFromOutput(output: string): unknown {
	// Find the first line that starts with '{' or '['
	const lines = output.split('\n');
	let jsonStart = -1;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			jsonStart = i;
			break;
		}
	}

	if (jsonStart === -1) {
		throw new Error(`No JSON found in output:\n${output}`);
	}

	// Try parsing from jsonStart line onwards, accumulating lines until valid JSON
	let accumulated = '';
	for (let i = jsonStart; i < lines.length; i++) {
		accumulated += `${lines[i]}\n`;
		try {
			return JSON.parse(accumulated);
		} catch {
			// continue accumulating
		}
	}

	throw new Error(`Could not parse JSON from output starting at line ${jsonStart}:\n${output}`);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let pgAvailable = false;

/**
 * Seed N source records with status 'enriched' so bootstrap threshold checks pass.
 */
function seedSources(count: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const id = randomUUID();
		const hash = randomUUID(); // unique file_hash
		runSql(
			`INSERT INTO sources (id, filename, storage_path, file_hash, page_count, status) ` +
				`VALUES ('${id}', 'test-${id.slice(0, 8)}.pdf', 'raw/test-${id.slice(0, 8)}.pdf', '${hash}', 5, 'enriched') ` +
				`ON CONFLICT (id) DO NOTHING;`,
		);
		ids.push(id);
	}
	return ids;
}

/**
 * Seed entity records linked to source IDs (via story_entities is optional;
 * bootstrap reads entities directly).
 */
function seedEntities(entities: Array<{ name: string; type: string }>): string[] {
	const ids: string[] = [];
	for (const ent of entities) {
		const id = randomUUID();
		runSql(
			`INSERT INTO entities (id, name, type) ` +
				`VALUES ('${id}', '${ent.name.replace(/'/g, "''")}', '${ent.type}') ` +
				`ON CONFLICT (name, type) WHERE canonical_id IS NULL DO UPDATE SET updated_at = now() RETURNING id;`,
		);
		ids.push(id);
	}
	return ids;
}

/**
 * Seed taxonomy entries directly.
 */
function seedTaxonomy(
	entries: Array<{ canonical_name: string; entity_type: string; status: string; aliases?: string[] }>,
): void {
	for (const entry of entries) {
		const aliasArray = entry.aliases?.length
			? `ARRAY[${entry.aliases.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}]`
			: `ARRAY['${entry.canonical_name.replace(/'/g, "''")}']`;
		runSql(
			`INSERT INTO taxonomy (canonical_name, entity_type, status, aliases) ` +
				`VALUES ('${entry.canonical_name.replace(/'/g, "''")}', '${entry.entity_type}', '${entry.status}', ${aliasArray}) ` +
				`ON CONFLICT (canonical_name, entity_type) DO UPDATE SET status = '${entry.status}', aliases = ${aliasArray};`,
		);
	}
}

function cleanTestData(): void {
	runSql(
		'DELETE FROM taxonomy; ' +
			'DELETE FROM chunks; DELETE FROM story_entities; DELETE FROM entity_edges; DELETE FROM entity_aliases; ' +
			'DELETE FROM entities; DELETE FROM stories; DELETE FROM source_steps; ' +
			'DELETE FROM pipeline_run_sources; DELETE FROM pipeline_runs; DELETE FROM sources;',
	);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
	pgAvailable = isPgAvailable();
	if (!pgAvailable) return;
	ensureSchema();
	cleanTestData();
});

afterAll(() => {
	if (!pgAvailable) return;
	cleanTestData();
});

// ---------------------------------------------------------------------------
// QA Contract Tests (QA-01 to QA-10)
// ---------------------------------------------------------------------------

describe('Spec 46 — Taxonomy Bootstrap (QA Contract)', () => {
	it('QA-01: Threshold enforcement — below threshold exits with TAXONOMY_BELOW_THRESHOLD', () => {
		if (!pgAvailable) return;

		// Ensure no sources exist (corpus size = 0, threshold default = 25)
		cleanTestData();

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toContain('TAXONOMY_BELOW_THRESHOLD');
		// Message must include corpus size and threshold
		expect(combined).toMatch(/0/);
		expect(combined).toMatch(/25/);
	});

	it('QA-02: Threshold override — --min-docs allows bootstrap to proceed', () => {
		if (!pgAvailable) return;

		cleanTestData();
		// Seed 5 sources so we have a corpus
		seedSources(5);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap', '--min-docs', '3']);
		const combined = stdout + stderr;

		// Should succeed (not fail with threshold error)
		expect(combined).not.toContain('TAXONOMY_BELOW_THRESHOLD');
		expect(exitCode).toBe(0);
	});

	it('QA-03: Bootstrap creates auto entries — new taxonomy entries have status=auto', () => {
		if (!pgAvailable) return;

		cleanTestData();
		// Seed enough sources to pass threshold override
		seedSources(3);
		// Seed entities of known types
		seedEntities([
			{ name: 'Alice Smith', type: 'person' },
			{ name: 'Alice S.', type: 'person' },
			{ name: 'Bob Jones', type: 'person' },
			{ name: 'New York', type: 'location' },
			{ name: 'NYC', type: 'location' },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap', '--min-docs', '1', '--json']);

		// In dev mode, Gemini calls return cached/dev responses.
		// If it succeeds, check the DB for auto entries.
		// If it fails because no Gemini mock is available, we SKIP.
		if (exitCode !== 0) {
			const combined = stdout + stderr;
			// Dev-mode Vertex returns a mock response; if bootstrap crashes parsing it,
			// that's a real implementation bug (missing response validation).
			// We still skip if Gemini is completely unavailable (network/auth issues).
			if (combined.match(/ECONNREFUSED|api.*key.*missing|authentication/i)) {
				console.warn('SKIP QA-03: Gemini/Vertex completely unavailable in test environment');
				return;
			}
			// "response.clusters is not iterable" = implementation bug (no response validation)
			// Report as a genuine failure
			expect.fail(`Bootstrap failed (exit ${exitCode}): ${combined}`);
		}

		// Verify taxonomy entries were created with status 'auto'
		const autoCount = runSql("SELECT COUNT(*) FROM taxonomy WHERE status = 'auto';");
		expect(Number(autoCount)).toBeGreaterThan(0);

		// Verify they have canonical_name and aliases
		const entries = runSql("SELECT canonical_name, aliases FROM taxonomy WHERE status = 'auto' LIMIT 5;");
		expect(entries.length).toBeGreaterThan(0);
	});

	it('QA-04: Bootstrap groups by type — taxonomy entries have correct entity_type', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedSources(3);
		seedEntities([
			{ name: 'Alice', type: 'person' },
			{ name: 'ACME Corp', type: 'organization' },
			{ name: 'Paris', type: 'location' },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap', '--min-docs', '1', '--json']);

		if (exitCode !== 0) {
			const combined = stdout + stderr;
			if (combined.match(/ECONNREFUSED|api.*key.*missing|authentication/i)) {
				console.warn('SKIP QA-04: Gemini/Vertex completely unavailable');
				return;
			}
			expect.fail(`Bootstrap failed (exit ${exitCode}): ${combined}`);
		}

		// Parse JSON output
		const result = parseJsonFromOutput(stdout) as { typesProcessed?: string[] };

		// typesProcessed should include the entity types we seeded
		if (result.typesProcessed && result.typesProcessed.length > 0) {
			// Check each taxonomy entry has an entity_type matching one of our seeded types
			const types = runSql("SELECT DISTINCT entity_type FROM taxonomy WHERE status = 'auto';");
			const typeList = types.split('\n').filter(Boolean);
			for (const t of typeList) {
				expect(['person', 'organization', 'location']).toContain(t);
			}
		}
	});

	it('QA-05: Confirmed entries preserved — bootstrap does not modify confirmed entries', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedSources(3);
		seedEntities([
			{ name: 'Confirmed Person', type: 'person' },
			{ name: 'New Person', type: 'person' },
		]);

		// Insert a confirmed taxonomy entry
		seedTaxonomy([{ canonical_name: 'Confirmed Person', entity_type: 'person', status: 'confirmed', aliases: ['CP'] }]);

		const confirmedBefore = runSql(
			"SELECT canonical_name, aliases FROM taxonomy WHERE status = 'confirmed' AND canonical_name = 'Confirmed Person';",
		);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap', '--min-docs', '1']);

		if (exitCode !== 0) {
			const combined = stdout + stderr;
			if (combined.match(/ECONNREFUSED|api.*key.*missing|authentication/i)) {
				console.warn('SKIP QA-05: Gemini/Vertex completely unavailable');
				return;
			}
			expect.fail(`Bootstrap failed (exit ${exitCode}): ${combined}`);
		}

		// Confirmed entry must still exist and be unchanged
		const confirmedAfter = runSql(
			"SELECT canonical_name, aliases FROM taxonomy WHERE status = 'confirmed' AND canonical_name = 'Confirmed Person';",
		);
		expect(confirmedAfter).toBe(confirmedBefore);
	});

	it('QA-06: Re-bootstrap replaces auto, keeps confirmed', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedSources(3);
		seedEntities([{ name: 'Test Entity', type: 'person' }]);

		// Seed both auto and confirmed entries
		seedTaxonomy([
			{ canonical_name: 'Auto Entry', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Confirmed Entry', entity_type: 'person', status: 'confirmed' },
		]);

		const confirmedBefore = runSql("SELECT id, canonical_name FROM taxonomy WHERE status = 'confirmed';");

		runCli(['taxonomy', 're-bootstrap', '--json'], { timeout: 60000 });

		// Re-bootstrap first deletes auto entries, then calls bootstrap.
		// If bootstrap fails due to threshold (corpus < 25 and no override),
		// that's expected — but auto entries should already be deleted.
		// Check that confirmed entries are preserved regardless.
		const confirmedAfter = runSql("SELECT id, canonical_name FROM taxonomy WHERE status = 'confirmed';");
		expect(confirmedAfter).toBe(confirmedBefore);

		// Auto entries should be deleted (re-bootstrap deletes them before calling bootstrap)
		const autoAfter = runSql("SELECT COUNT(*) FROM taxonomy WHERE status = 'auto' AND canonical_name = 'Auto Entry';");
		expect(Number(autoAfter)).toBe(0);
	});

	it('QA-07: Show displays taxonomy — output shows entries grouped by type', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([
			{ canonical_name: 'Alice', entity_type: 'person', status: 'auto', aliases: ['Alice S.'] },
			{ canonical_name: 'New York', entity_type: 'location', status: 'confirmed', aliases: ['NYC', 'New York City'] },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'show']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		// Output should mention both types
		expect(combined).toContain('person');
		expect(combined).toContain('location');
		// Output should include canonical names
		expect(combined).toContain('Alice');
		expect(combined).toContain('New York');
		// Output should include status indicators
		expect(combined).toMatch(/auto|confirmed/);
	});

	it('QA-08: Show with --json produces valid JSON grouped by type', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([
			{ canonical_name: 'Alice', entity_type: 'person', status: 'auto', aliases: ['Alice S.'] },
			{ canonical_name: 'Berlin', entity_type: 'location', status: 'confirmed', aliases: ['Berlin, Germany'] },
		]);

		const { exitCode, stdout } = runCli(['taxonomy', 'show', '--json']);
		expect(exitCode).toBe(0);

		const parsed = parseJsonFromOutput(stdout) as Record<string, unknown>;
		expect(parsed).toBeDefined();
		expect(typeof parsed).toBe('object');

		// Should have keys for each entity type
		expect(parsed).toHaveProperty('person');
		expect(parsed).toHaveProperty('location');
	});

	it('QA-09: Show with --type filter returns only the specified type', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([
			{ canonical_name: 'Alice', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'Berlin', entity_type: 'location', status: 'auto' },
			{ canonical_name: 'Acme', entity_type: 'organization', status: 'auto' },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'show', '--type', 'person']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toContain('person');
		expect(combined).toContain('Alice');
		// Should NOT contain entries from other types
		expect(combined).not.toContain('Berlin');
		expect(combined).not.toContain('Acme');
	});

	it('QA-10: Bootstrap idempotency — running twice does not duplicate entries', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedSources(3);
		seedEntities([
			{ name: 'Idempotent Person', type: 'person' },
			{ name: 'Idempotent Place', type: 'location' },
		]);

		// First run
		const first = runCli(['taxonomy', 'bootstrap', '--min-docs', '1']);
		if (first.exitCode !== 0) {
			const combined = first.stdout + first.stderr;
			if (combined.match(/ECONNREFUSED|api.*key.*missing|authentication/i)) {
				console.warn('SKIP QA-10: Gemini/Vertex completely unavailable');
				return;
			}
			expect.fail(`First bootstrap failed: ${combined}`);
		}

		const countAfterFirst = Number(runSql('SELECT COUNT(*) FROM taxonomy;'));

		// Second run
		const second = runCli(['taxonomy', 'bootstrap', '--min-docs', '1']);
		if (second.exitCode !== 0) {
			const combined = second.stdout + second.stderr;
			if (combined.match(/ECONNREFUSED|api.*key.*missing|authentication/i)) {
				console.warn('SKIP QA-10: Gemini/Vertex completely unavailable (second run)');
				return;
			}
			expect.fail(`Second bootstrap failed: ${combined}`);
		}

		const countAfterSecond = Number(runSql('SELECT COUNT(*) FROM taxonomy;'));

		// Entry count should not grow unboundedly (upsert semantics)
		expect(countAfterSecond).toBeLessThanOrEqual(countAfterFirst * 2);
		// More precisely, the count should be the same or only marginally larger
		// (the LLM might cluster slightly differently, but it should upsert)
		expect(countAfterSecond).toBeLessThanOrEqual(countAfterFirst + 5);
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix (CLI-01 to CLI-09)
// ---------------------------------------------------------------------------

describe('Spec 46 — Taxonomy Bootstrap (CLI Test Matrix)', () => {
	it('CLI-01: `taxonomy bootstrap --help` shows usage with --min-docs flag', () => {
		const { exitCode, stdout } = runCli(['taxonomy', 'bootstrap', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('--min-docs');
		expect(stdout).toMatch(/bootstrap/i);
	});

	it('CLI-02: `taxonomy bootstrap` with no flags and < threshold docs exits with threshold error', () => {
		if (!pgAvailable) return;

		cleanTestData();
		// No sources seeded = 0 docs, threshold is 25

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toContain('TAXONOMY_BELOW_THRESHOLD');
	});

	it('CLI-03: `taxonomy bootstrap --min-docs 3` proceeds with override', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedSources(5);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap', '--min-docs', '3']);
		const combined = stdout + stderr;

		expect(combined).not.toContain('TAXONOMY_BELOW_THRESHOLD');
		expect(exitCode).toBe(0);
	});

	it('CLI-04: `taxonomy bootstrap --json` produces JSON output', () => {
		if (!pgAvailable) return;

		cleanTestData();
		// Seed sources but NO entities — bootstrap will succeed with 0 entries
		// but still produce JSON output, which is what we're testing.
		seedSources(3);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'bootstrap', '--min-docs', '1', '--json']);
		expect(exitCode, `Unexpected failure: ${stdout + stderr}`).toBe(0);

		// Output should contain valid JSON
		const parsed = parseJsonFromOutput(stdout);
		expect(parsed).toBeDefined();
		expect(typeof parsed).toBe('object');
		const result = parsed as { entriesCreated?: number; entriesUpdated?: number; corpusSize?: number };
		expect(result).toHaveProperty('entriesCreated');
		expect(result).toHaveProperty('entriesUpdated');
		expect(result).toHaveProperty('corpusSize');
	});

	it('CLI-05: `taxonomy re-bootstrap --help` shows usage', () => {
		const { exitCode, stdout } = runCli(['taxonomy', 're-bootstrap', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/re-bootstrap/i);
		expect(stdout).toMatch(/--json/);
	});

	it('CLI-06: `taxonomy show --help` shows usage', () => {
		const { exitCode, stdout } = runCli(['taxonomy', 'show', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/show/i);
		expect(stdout).toContain('--type');
		expect(stdout).toContain('--json');
	});

	it('CLI-07: `taxonomy show` with no flags outputs formatted tree', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([{ canonical_name: 'TreeTest Person', entity_type: 'person', status: 'auto', aliases: ['TTP'] }]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'show']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toContain('person');
		expect(combined).toContain('TreeTest Person');
	});

	it('CLI-08: `taxonomy show --type person` filters by type', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([
			{ canonical_name: 'FilterPerson', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'FilterLocation', entity_type: 'location', status: 'auto' },
		]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'show', '--type', 'person']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toContain('FilterPerson');
		expect(combined).not.toContain('FilterLocation');
	});

	it('CLI-09: `taxonomy show --json` produces valid JSON output', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([{ canonical_name: 'JsonPerson', entity_type: 'person', status: 'auto', aliases: ['JP'] }]);

		const { exitCode, stdout } = runCli(['taxonomy', 'show', '--json']);
		expect(exitCode).toBe(0);

		const parsed = parseJsonFromOutput(stdout);
		expect(parsed).toBeDefined();
		expect(typeof parsed).toBe('object');
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: taxonomy subcommands', () => {
	it('SMOKE-01: `taxonomy --help` exits 0 and lists all subcommands', () => {
		const { exitCode, stdout } = runCli(['taxonomy', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('bootstrap');
		expect(stdout).toContain('re-bootstrap');
		expect(stdout).toContain('show');
	});

	it('SMOKE-02: `taxonomy` with no subcommand shows help', () => {
		const { stdout, stderr } = runCli(['taxonomy']);
		const combined = stdout + stderr;

		// Commander.js may exit 0 or 1 when no subcommand is given, depending on config.
		// The important thing is that it shows help text listing subcommands.
		expect(combined).toContain('bootstrap');
		expect(combined).toContain('show');
		expect(combined).toContain('re-bootstrap');
	});

	it('SMOKE-03: `taxonomy bootstrap --min-docs` without value exits non-zero', () => {
		const { exitCode, stderr, stdout } = runCli(['taxonomy', 'bootstrap', '--min-docs']);
		const combined = stdout + stderr;

		// Missing argument to --min-docs should cause an error
		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/min-docs|argument|required|missing/i);
	});

	it('SMOKE-04: `taxonomy show --type` without value exits non-zero', () => {
		const { exitCode, stderr, stdout } = runCli(['taxonomy', 'show', '--type']);
		const combined = stdout + stderr;

		// Missing argument to --type should cause an error
		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/type|argument|required|missing/i);
	});

	it('SMOKE-05: `taxonomy show --json --type person` combined flags work', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([
			{ canonical_name: 'ComboPerson', entity_type: 'person', status: 'auto' },
			{ canonical_name: 'ComboLocation', entity_type: 'location', status: 'auto' },
		]);

		const { exitCode, stdout } = runCli(['taxonomy', 'show', '--json', '--type', 'person']);
		expect(exitCode).toBe(0);

		const parsed = parseJsonFromOutput(stdout) as Record<string, unknown>;
		expect(parsed).toHaveProperty('person');
		expect(parsed).not.toHaveProperty('location');
	});

	it('SMOKE-06: `taxonomy re-bootstrap --json` produces JSON output (even on error)', () => {
		if (!pgAvailable) return;

		cleanTestData();
		// No sources, so re-bootstrap will delete auto entries then fail threshold check.
		// With --json, the error should still be machine-readable or the error message present.

		const { stdout, stderr } = runCli(['taxonomy', 're-bootstrap', '--json']);
		const combined = stdout + stderr;

		// Should at least have some output (error message or JSON)
		expect(combined.length).toBeGreaterThan(0);
		// Should mention threshold since corpus is empty
		expect(combined).toContain('TAXONOMY_BELOW_THRESHOLD');
	});

	it('SMOKE-07: `taxonomy bootstrap --min-docs 0` with empty entities succeeds with 0 results', () => {
		if (!pgAvailable) return;

		cleanTestData();
		// No sources, no entities, but --min-docs 0 bypasses threshold

		const { exitCode, stdout } = runCli(['taxonomy', 'bootstrap', '--min-docs', '0', '--json']);
		expect(exitCode).toBe(0);

		const result = parseJsonFromOutput(stdout) as { entriesCreated: number };
		expect(result.entriesCreated).toBe(0);
	});

	it('SMOKE-08: `taxonomy show` with empty taxonomy shows no entries gracefully', () => {
		if (!pgAvailable) return;

		cleanTestData();

		const { exitCode } = runCli(['taxonomy', 'show']);

		// Should exit 0 even when no taxonomy entries exist
		expect(exitCode).toBe(0);
	});

	it('SMOKE-09: `taxonomy show --json` with empty taxonomy returns valid empty JSON', () => {
		if (!pgAvailable) return;

		cleanTestData();

		const { exitCode, stdout } = runCli(['taxonomy', 'show', '--json']);
		expect(exitCode).toBe(0);

		const parsed = parseJsonFromOutput(stdout);
		expect(parsed).toBeDefined();
		expect(typeof parsed).toBe('object');
		// Should be an empty object since no entries exist
		expect(Object.keys(parsed as Record<string, unknown>).length).toBe(0);
	});

	it('SMOKE-10: `taxonomy show --type nonexistent` returns empty result', () => {
		if (!pgAvailable) return;

		cleanTestData();
		seedTaxonomy([{ canonical_name: 'Alice', entity_type: 'person', status: 'auto' }]);

		const { exitCode, stdout, stderr } = runCli(['taxonomy', 'show', '--type', 'nonexistent_type']);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).not.toContain('Alice');
	});
});
