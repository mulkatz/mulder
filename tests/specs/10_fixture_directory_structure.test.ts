import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 10: Fixture Directory Structure
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: filesystem checks.
 * No imports from packages/ or src/.
 */
describe('Spec 10: Fixture Directory Structure', () => {
	const FIXTURES_ROOT = resolve(ROOT, 'fixtures');

	// The 6 required subdirectories per spec §2 / QA-01
	const REQUIRED_SUBDIRS = ['raw', 'extracted', 'segments', 'entities', 'embeddings', 'grounding'];

	// Subdirectories that must have _schema.json (all except raw/)
	const SCHEMA_SUBDIRS = ['extracted', 'segments', 'entities', 'embeddings', 'grounding'];

	// The 6 usage rules from functional spec §11.3
	const USAGE_RULES = [
		'Pipeline step tests MUST load fixtures',
		'Fixtures are committed to the repo and version-controlled',
		'README documents which API version produced each fixture',
		'When an API response format changes, update the fixture AND the test',
		'zod-to-json-schema',
		'mulder fixtures generate',
	];

	// ─── QA-01: Directory structure exists ───

	describe('QA-01: Directory structure exists', () => {
		it('fixtures/ root directory exists', () => {
			expect(existsSync(FIXTURES_ROOT), 'fixtures/ directory does not exist').toBe(true);
		});

		it('all 6 required subdirectories exist: raw/, extracted/, segments/, entities/, embeddings/, grounding/', () => {
			for (const subdir of REQUIRED_SUBDIRS) {
				const dirPath = resolve(FIXTURES_ROOT, subdir);
				expect(existsSync(dirPath), `Missing fixture subdirectory: ${subdir}/`).toBe(true);
			}
		});
	});

	// ─── QA-02: Git preserves empty directories ───

	describe('QA-02: Git preserves directories', () => {
		it('empty subdirectories have a .gitkeep file', () => {
			// Only raw/ needs .gitkeep — other dirs have _schema.json which preserves them
			const gitkeepPath = resolve(FIXTURES_ROOT, 'raw', '.gitkeep');
			expect(existsSync(gitkeepPath), 'Missing .gitkeep in fixtures/raw/').toBe(true);
		});

		it('every subdirectory has at least one tracked file', () => {
			for (const subdir of REQUIRED_SUBDIRS) {
				const gitOutput = execFileSync('git', ['ls-files', `fixtures/${subdir}/`], {
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 10_000,
				});
				expect(gitOutput.trim().length, `fixtures/${subdir}/ has no tracked files`).toBeGreaterThan(0);
			}
		});
	});

	// ─── QA-03: Schema placeholders document expected formats ───

	describe('QA-03: Schema placeholders document expected formats', () => {
		it('_schema.json exists in extracted/, segments/, entities/, embeddings/, grounding/', () => {
			for (const subdir of SCHEMA_SUBDIRS) {
				const schemaPath = resolve(FIXTURES_ROOT, subdir, '_schema.json');
				expect(existsSync(schemaPath), `Missing _schema.json in fixtures/${subdir}/`).toBe(true);
			}
		});

		it('each _schema.json is valid JSON', () => {
			for (const subdir of SCHEMA_SUBDIRS) {
				const schemaPath = resolve(FIXTURES_ROOT, subdir, '_schema.json');
				const content = readFileSync(schemaPath, 'utf-8');
				expect(() => JSON.parse(content), `fixtures/${subdir}/_schema.json is not valid JSON`).not.toThrow();
			}
		});

		it('each _schema.json has "description", "api", and "structure" fields', () => {
			for (const subdir of SCHEMA_SUBDIRS) {
				const schemaPath = resolve(FIXTURES_ROOT, subdir, '_schema.json');
				const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

				expect(schema, `fixtures/${subdir}/_schema.json missing required fields`).toEqual(
					expect.objectContaining({
						description: expect.any(String),
						api: expect.any(String),
						structure: expect.any(Object),
					}),
				);

				// Ensure fields are non-empty
				expect(schema.description.length, `fixtures/${subdir}/_schema.json has empty description`).toBeGreaterThan(0);
				expect(schema.api.length, `fixtures/${subdir}/_schema.json has empty api`).toBeGreaterThan(0);
				expect(
					Object.keys(schema.structure).length,
					`fixtures/${subdir}/_schema.json has empty structure`,
				).toBeGreaterThan(0);
			}
		});

		it('raw/ does NOT have _schema.json (no GCP API output for raw PDFs)', () => {
			const rawSchemaPath = resolve(FIXTURES_ROOT, 'raw', '_schema.json');
			expect(existsSync(rawSchemaPath), 'raw/ should not have _schema.json').toBe(false);
		});
	});

	// ─── QA-04: README documents usage rules ───

	describe('QA-04: README documents usage rules', () => {
		let readmeContent: string;

		beforeAll(() => {
			const readmePath = resolve(FIXTURES_ROOT, 'README.md');
			expect(existsSync(readmePath), 'fixtures/README.md does not exist').toBe(true);
			readmeContent = readFileSync(readmePath, 'utf-8');
		});

		it('fixtures/README.md exists and is non-empty', () => {
			expect(readmeContent.length).toBeGreaterThan(0);
		});

		it('README contains all 6 usage rules from §11.3', () => {
			for (const rule of USAGE_RULES) {
				expect(readmeContent, `README missing usage rule containing: "${rule}"`).toContain(rule);
			}
		});

		it('README contains a "Usage Rules" section', () => {
			expect(readmeContent, 'README missing "Usage Rules" section heading').toMatch(/##\s+Usage Rules/);
		});

		it('README documents the directory layout', () => {
			// Should mention all 6 subdirectories
			for (const subdir of REQUIRED_SUBDIRS) {
				expect(readmeContent, `README does not mention fixtures/${subdir}/`).toContain(`${subdir}/`);
			}
		});

		it('README documents fixture generation command', () => {
			expect(readmeContent, 'README does not mention mulder fixtures generate').toContain('mulder fixtures generate');
		});
	});

	// ─── QA-05: No regression — existing tests pass ───
	// This is verified by running the full test suite separately (step 4 of the QA task).
	// We include a sanity check here that the fixtures structure does not interfere with the build.

	describe('QA-05: No regression — existing tests pass', () => {
		it('fixture files do not interfere with TypeScript compilation (no .ts files in fixtures/)', () => {
			let _grepExitCode: number;
			let grepOutput = '';
			try {
				grepOutput = execFileSync('find', [FIXTURES_ROOT, '-name', '*.ts', '-type', 'f'], {
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 10_000,
				});
				_grepExitCode = 0;
			} catch (e: unknown) {
				const error = e as { status?: number; stdout?: string };
				_grepExitCode = error.status ?? 1;
				grepOutput = error.stdout ?? '';
			}

			const tsFiles = grepOutput.trim().split('\n').filter(Boolean);
			expect(tsFiles, `Unexpected .ts files in fixtures/: ${tsFiles.join(', ')}`).toHaveLength(0);
		});
	});

	// ─── QA-06: No regression — build succeeds ───

	describe('QA-06: No regression — build succeeds', () => {
		let buildExitCode: number;
		let buildOutput: string;

		beforeAll(() => {
			try {
				buildOutput = execFileSync('pnpm', ['turbo', 'run', 'build'], {
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 120_000,
				});
				buildExitCode = 0;
			} catch (e: unknown) {
				const error = e as { status?: number; stdout?: string; stderr?: string };
				buildExitCode = error.status ?? 1;
				buildOutput = (error.stdout ?? '') + (error.stderr ?? '');
			}
		});

		it('pnpm turbo run build exits 0', () => {
			expect(buildExitCode, `Build failed:\n${buildOutput}`).toBe(0);
		});
	});
});
