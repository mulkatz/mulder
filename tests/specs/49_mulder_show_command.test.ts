/**
 * Black-box QA tests for Spec 49: `mulder show` command.
 *
 * Each test maps to one QA condition from §5 or one CLI case from §5b of
 * docs/specs/49_mulder_show_command.spec.md. The tests exercise the system
 * exclusively through public boundaries:
 *
 *   1. The `mulder show` CLI via `spawnSync` against apps/cli/dist.
 *   2. The filesystem (dev-mode storage under .local/storage/extracted/).
 *   3. Direct Postgres writes (for the synthetic GFM-table fixture — the
 *      repo has no table-containing raw PDF, so we seed a `sources` row
 *      and hand-craft a layout.md under .local/storage/ to exercise
 *      QA-08 without reading implementation code).
 *
 * No imports from packages/*|/src, apps/*|/src, or src/. Dist-barrel and
 * CLI binary only.
 *
 * Infra dependencies:
 *   - A running `mulder-pg-test` PostgreSQL container (same as spec 19, 48).
 *   - Built `apps/cli/dist/index.js`.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_RAW_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_RAW_DIR, 'native-text-sample.pdf');
const EXTRACTED_STORAGE_DIR = resolve(ROOT, '.local/storage/extracted');
const RAW_STORAGE_DIR = resolve(ROOT, '.local/storage/raw');

// ---------------------------------------------------------------------------
// Docker / PG helpers (shared with spec 19, 48 container)
// ---------------------------------------------------------------------------

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

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

function runSql(sql: string): string {
	const result = spawnSync(
		'docker',
		['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
		{ encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number; forceColor?: boolean },
): { stdout: string; stderr: string; exitCode: number } {
	// Chalk disables ANSI escapes by default when stdout is not a TTY (which
	// it isn't under spawnSync). Tests that assert on ANSI output set
	// `forceColor: true` to propagate FORCE_COLOR=1 into the child process.
	const baseEnv: Record<string, string> = { ...process.env, PGPASSWORD: PG_PASSWORD };
	if (opts?.forceColor) {
		baseEnv.FORCE_COLOR = '1';
	}
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 90_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...baseEnv, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Native-text-sample.pdf body marker — a substring that is guaranteed to
 * appear in the extracted layout.md body for the fixture PDF. Used as a
 * "body text present" probe by QA-01 / CLI-01 / CLI-03 / CLI-04.
 */
const NATIVE_TEXT_BODY_MARKER = 'This is the first page of the native text sample document';

function cleanTestData(): void {
	runSql('DELETE FROM source_steps; DELETE FROM sources;');
}

function cleanExtractedStorage(): void {
	if (existsSync(EXTRACTED_STORAGE_DIR)) {
		for (const entry of readdirSync(EXTRACTED_STORAGE_DIR)) {
			if (entry === '_schema.json') continue;
			rmSync(join(EXTRACTED_STORAGE_DIR, entry), { recursive: true, force: true });
		}
	}
}

function cleanRawStorage(): void {
	if (existsSync(RAW_STORAGE_DIR)) {
		for (const entry of readdirSync(RAW_STORAGE_DIR)) {
			if (entry === '_schema.json') continue;
			rmSync(join(RAW_STORAGE_DIR, entry), { recursive: true, force: true });
		}
	}
}

/**
 * Ingest the native-text sample PDF and return its source UUID.
 */
function ingestNativeTextPdf(): string {
	const { exitCode, stdout, stderr } = runCli(['ingest', NATIVE_TEXT_PDF]);
	if (exitCode !== 0) {
		throw new Error(`Ingest failed (exit ${exitCode}): ${stdout} ${stderr}`);
	}
	const sourceId = runSql(
		"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
	);
	if (!sourceId) {
		throw new Error('No source record found after ingest');
	}
	return sourceId;
}

/**
 * Extract an already-ingested source via the CLI.
 */
function extractSource(sourceId: string): void {
	const { exitCode, stdout, stderr } = runCli(['extract', sourceId]);
	if (exitCode !== 0) {
		throw new Error(`Extract failed (exit ${exitCode}): ${stdout} ${stderr}`);
	}
}

/**
 * Quote and escape a string for safe inclusion in a psql single-quoted literal.
 */
function sqlQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Seed a synthetic `sources` row directly in Postgres (for the table-fixture
 * case, where we don't want to run the full extract pipeline). Returns the
 * new UUID.
 */
function seedSyntheticSource(filename: string): string {
	const id = randomUUID();
	const storagePath = `raw/${id}/${filename}`;
	const fileHash = `qa-49-${id}`;
	runSql(
		`INSERT INTO sources (id, filename, storage_path, file_hash, status, page_count)
		 VALUES (${sqlQuote(id)}, ${sqlQuote(filename)}, ${sqlQuote(storagePath)}, ${sqlQuote(
			fileHash,
		)}, 'extracted', 1);`,
	);
	return id;
}

/**
 * Write a file under .local/storage/extracted/{id}/{name}, creating parent
 * dirs as needed. Used by QA-08 to hand-craft a layout.md with a GFM table.
 */
function writeSyntheticLayoutMd(sourceId: string, content: string): string {
	const dir = join(EXTRACTED_STORAGE_DIR, sourceId);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'layout.md');
	writeFileSync(path, content, 'utf-8');
	return path;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Spec 49 — `mulder show` command', () => {
	let pgAvailable = false;

	// Shared source IDs used across multiple tests.
	let srcId = '';
	let unextractedId = '';
	let syntheticTableId = '';

	const NONEXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

	const SYNTHETIC_TABLE_MD = [
		'# Synthetic QA Table',
		'',
		'Body paragraph before the table.',
		'',
		'| Col1 | Col2 |',
		'| --- | --- |',
		'| A | B |',
		'| C | D |',
		'',
		'Trailing paragraph.',
		'',
	].join('\n');

	beforeAll(async () => {
		expect(existsSync(CLI), `CLI not built: ${CLI}`).toBe(true);

		pgAvailable = isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: mulder-pg-test container not running — all spec 49 tests will be skipped.\n' +
					'  Start with: docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
			return;
		}

		// Ensure schema is migrated (idempotent — matches spec 19, 48 pattern).
		const migrate = runCli(['db', 'migrate', resolve(ROOT, 'mulder.config.example.yaml')]);
		if (migrate.exitCode !== 0) {
			throw new Error(`Migration failed: ${migrate.stdout} ${migrate.stderr}`);
		}

		cleanTestData();
		cleanExtractedStorage();
		cleanRawStorage();

		// $SRC_ID — fully ingested + extracted, known to have a layout.md.
		srcId = ingestNativeTextPdf();
		extractSource(srcId);
		const mdPath = join(EXTRACTED_STORAGE_DIR, srcId, 'layout.md');
		expect(existsSync(mdPath), `layout.md missing after extract: ${mdPath}`).toBe(true);

		// $UNEXTRACTED_ID — ingested but never extracted. Because file_hash is
		// unique per-source we can't ingest the same PDF twice cleanly, so we
		// seed a synthetic row directly. The row is marked status='ingested'
		// to match the spec's precondition for QA-05 / CLI-08.
		unextractedId = randomUUID();
		runSql(
			`INSERT INTO sources (id, filename, storage_path, file_hash, status, page_count)
			 VALUES (${sqlQuote(unextractedId)}, 'qa49-unextracted.pdf',
			         ${sqlQuote(`raw/${unextractedId}/qa49-unextracted.pdf`)},
			         ${sqlQuote(`qa-49-unextracted-${unextractedId}`)}, 'ingested', 1);`,
		);

		// $TEST_ID — synthetic source + hand-crafted layout.md with a GFM
		// table, so QA-08 can assert the table-separator dim sequence without
		// needing a table-containing raw PDF (which the repo doesn't ship).
		syntheticTableId = seedSyntheticSource('qa49-table.pdf');
		writeSyntheticLayoutMd(syntheticTableId, SYNTHETIC_TABLE_MD);
	});

	afterAll(() => {
		if (!pgAvailable) return;
		try {
			// Drop synthetic rows + any extracted-storage droppings.
			cleanTestData();
			cleanExtractedStorage();
			cleanRawStorage();
		} catch {
			// best effort
		}
	});

	// ═══════════════════════════════════════════════════════════════════════
	// §5 — QA Conditions
	// ═══════════════════════════════════════════════════════════════════════

	// ─── QA-01: Happy path with ANSI formatting ───
	it.skipIf(!isPgAvailable())(
		'QA-01: show <id> → exit 0, body text present, contains ANSI escape',
		() => {
			// FORCE_COLOR=1 propagates through to chalk so ANSI is emitted
			// even though stdout is a pipe, not a TTY.
			const result = runCli(['show', srcId], { forceColor: true });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.length).toBeGreaterThan(0);
			// Known body content from the extracted native-text-sample.pdf.
			expect(result.stdout).toContain(NATIVE_TEXT_BODY_MARKER);
			// At least one ANSI escape sequence (from chalk's formatting).
			expect(result.stdout).toContain('\x1b[');
		},
	);

	// ─── QA-02: --raw produces byte-identical markdown, zero ANSI ───
	it.skipIf(!isPgAvailable())(
		'QA-02: show <id> --raw → byte-identical to stored layout.md, no ANSI',
		() => {
			const rawFile = readFileSync(join(EXTRACTED_STORAGE_DIR, srcId, 'layout.md'), 'utf-8');
			const result = runCli(['show', srcId, '--raw']);
			expect(result.exitCode).toBe(0);

			// No ANSI escape sequences at all.
			expect(result.stdout.includes('\x1b[')).toBe(false);

			// Normalize an optional single trailing newline on either side and
			// compare byte-for-byte.
			const norm = (s: string) => (s.endsWith('\n') ? s : `${s}\n`);
			expect(norm(result.stdout)).toBe(norm(rawFile));
		},
	);

	// ─── QA-03: --help prints usage information ───
	it('QA-03: show --help → exit 0, usage info includes arg + flags', () => {
		const result = runCli(['show', '--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Usage:');
		expect(result.stdout).toContain('show');
		expect(result.stdout).toContain('source-id');
		expect(result.stdout).toContain('--raw');
		expect(result.stdout).toContain('--pager');
	});

	// ─── QA-04: Nonexistent source ID → exit 1, clear error ───
	it.skipIf(!isPgAvailable())(
		'QA-04: show <nonexistent-uuid> → exit 1, stderr "Source not found" + UUID',
		() => {
			const result = runCli(['show', NONEXISTENT_UUID]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('Source not found');
			expect(result.stderr).toContain(NONEXISTENT_UUID);
		},
	);

	// ─── QA-05: Source exists but layout.md missing → exit 1, clear error ───
	it.skipIf(!isPgAvailable())(
		'QA-05: show <ingested-only-id> → exit 1, stderr "layout.md not found" + "mulder extract"',
		() => {
			const result = runCli(['show', unextractedId]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('layout.md not found');
			expect(result.stderr).toContain('mulder extract');
		},
	);

	// ─── QA-06: Formatter is deterministic (idempotency) ───
	it.skipIf(!isPgAvailable())(
		'QA-06: show <id> twice → byte-identical stdouts',
		() => {
			const first = runCli(['show', srcId]);
			const second = runCli(['show', srcId]);
			expect(first.exitCode).toBe(0);
			expect(second.exitCode).toBe(0);
			expect(second.stdout).toBe(first.stdout);
		},
	);

	// ─── QA-07: --pager with PAGER=cat does not crash, produces output ───
	it.skipIf(!isPgAvailable())(
		'QA-07: show <id> --pager (PAGER=cat) → exit 0, body text passed through',
		() => {
			const result = runCli(['show', srcId, '--pager'], { env: { PAGER: 'cat' } });
			expect(result.exitCode).toBe(0);
			// The cat pager passes formatted output through, so the body text
			// is still in stdout.
			expect(result.stdout).toContain(NATIVE_TEXT_BODY_MARKER);
		},
	);

	// ─── QA-08: GFM table separator row is dimmed ───
	it.skipIf(!isPgAvailable())(
		'QA-08: show <id> → GFM table separator row gets chalk.dim, data rows pass through',
		() => {
			const result = runCli(['show', syntheticTableId], { forceColor: true });
			expect(result.exitCode).toBe(0);

			// Spec §5 QA-08 asserts that the table separator row is dimmed
			// (`\x1b[2m` or the reset `\x1b[22m`) while data rows are NOT
			// immediately preceded by the dim-start sequence.
			expect(result.stdout.includes('\x1b[2m')).toBe(true);

			// Split into lines (preserving ANSI). The separator row contains
			// the GFM marker pattern `|---|`; the data row for `| A | B |` must
			// NOT be immediately preceded by the dim-start sequence on the
			// same line.
			const lines = result.stdout.split('\n');

			// Helper: strip chalk ANSI escapes to recover the bare line text
			// for identification.
			const strip = (s: string): string =>
				// eslint-disable-next-line no-control-regex
				s.replace(/\x1b\[[0-9;]*m/g, '');

			const sepIdx = lines.findIndex((l) => {
				const bare = strip(l).trim();
				return /^\|\s*-+\s*\|\s*-+\s*\|$/.test(bare);
			});
			expect(sepIdx, 'expected a GFM separator line in output').toBeGreaterThanOrEqual(0);

			// Separator row contains a dim-start escape on its line.
			expect(lines[sepIdx].includes('\x1b[2m')).toBe(true);

			// Data row "| A | B |" must not start with the dim-start escape
			// (chalk wraps the content it dims; a plain passthrough row has
			// no leading `\x1b[2m`).
			const dataIdx = lines.findIndex((l) => {
				const bare = strip(l).trim();
				return bare === '| A | B |';
			});
			expect(dataIdx, 'expected a GFM data row "| A | B |" in output').toBeGreaterThanOrEqual(0);
			expect(lines[dataIdx].startsWith('\x1b[2m')).toBe(false);
		},
	);

	// ═══════════════════════════════════════════════════════════════════════
	// §5b — CLI Test Matrix
	// ═══════════════════════════════════════════════════════════════════════

	describe('CLI matrix (§5b)', () => {
		// ─── CLI-01: plain show → exit 0, ANSI present ───
		it.skipIf(!isPgAvailable())('CLI-01: show $SRC_ID → exit 0, ANSI present', () => {
			const result = runCli(['show', srcId], { forceColor: true });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.length).toBeGreaterThan(0);
			expect(result.stdout).toContain(NATIVE_TEXT_BODY_MARKER);
			expect(result.stdout).toContain('\x1b[');
		});

		// ─── CLI-02: --raw → byte-identical, no ANSI ───
		it.skipIf(!isPgAvailable())(
			'CLI-02: show $SRC_ID --raw → byte-identical to stored layout.md, no ANSI',
			() => {
				const rawFile = readFileSync(join(EXTRACTED_STORAGE_DIR, srcId, 'layout.md'), 'utf-8');
				const result = runCli(['show', srcId, '--raw']);
				expect(result.exitCode).toBe(0);
				expect(result.stdout.includes('\x1b[')).toBe(false);

				const norm = (s: string) => (s.endsWith('\n') ? s : `${s}\n`);
				expect(norm(result.stdout)).toBe(norm(rawFile));
			},
		);

		// ─── CLI-03: --pager (PAGER=cat) → exit 0, body in stdout ───
		it.skipIf(!isPgAvailable())(
			'CLI-03: show $SRC_ID --pager (PAGER=cat) → exit 0, body text present',
			() => {
				const result = runCli(['show', srcId, '--pager'], { env: { PAGER: 'cat' } });
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain(NATIVE_TEXT_BODY_MARKER);
			},
		);

		// ─── CLI-04: --raw --pager (PAGER=cat) → raw markdown, no ANSI ───
		it.skipIf(!isPgAvailable())(
			'CLI-04: show $SRC_ID --raw --pager (PAGER=cat) → raw markdown, no ANSI',
			() => {
				const rawFile = readFileSync(join(EXTRACTED_STORAGE_DIR, srcId, 'layout.md'), 'utf-8');
				const result = runCli(['show', srcId, '--raw', '--pager'], {
					env: { PAGER: 'cat' },
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout.includes('\x1b[')).toBe(false);
				// `cat` passes the raw markdown through unchanged.
				expect(result.stdout).toContain(NATIVE_TEXT_BODY_MARKER);
				// Substring match (cat may or may not append a trailing newline,
				// and the pager path could add one more).
				expect(result.stdout.replace(/\n+$/, '')).toContain(rawFile.replace(/\n+$/, ''));
			},
		);

		// ─── CLI-05: --help → exit 0, usage info ───
		it('CLI-05: show --help → exit 0, usage info with all expected strings', () => {
			const result = runCli(['show', '--help']);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Usage:');
			expect(result.stdout).toContain('show');
			expect(result.stdout).toContain('source-id');
			expect(result.stdout).toContain('--raw');
			expect(result.stdout).toContain('--pager');
		});

		// ─── CLI-06: missing positional → non-zero, usage error ───
		it('CLI-06: show (missing positional) → non-zero, usage error mentioning source-id', () => {
			const result = runCli(['show']);
			expect(result.exitCode).not.toBe(0);
			// Commander reports missing arguments on stderr. Accept stderr OR
			// stdout defensively in case the implementation prints to either.
			const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
			expect(combined).toContain('source-id');
		});

		// ─── CLI-07: nonexistent UUID → exit 1, Source not found + UUID ───
		it.skipIf(!isPgAvailable())(
			'CLI-07: show <nonexistent-uuid> → exit 1, stderr "Source not found" + UUID',
			() => {
				const result = runCli(['show', NONEXISTENT_UUID]);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain('Source not found');
				expect(result.stderr).toContain(NONEXISTENT_UUID);
			},
		);

		// ─── CLI-08: ingested-but-not-extracted → exit 1, layout.md not found ───
		it.skipIf(!isPgAvailable())(
			'CLI-08: show $UNEXTRACTED_ID → exit 1, stderr "layout.md not found" + "mulder extract"',
			() => {
				const result = runCli(['show', unextractedId]);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain('layout.md not found');
				expect(result.stderr).toContain('mulder extract');
			},
		);

		// ─── CLI-09: run twice → byte-identical stdouts ───
		it.skipIf(!isPgAvailable())(
			'CLI-09: show $SRC_ID twice → both exit 0, byte-identical stdouts',
			() => {
				const first = runCli(['show', srcId]);
				const second = runCli(['show', srcId]);
				expect(first.exitCode).toBe(0);
				expect(second.exitCode).toBe(0);
				expect(second.stdout).toBe(first.stdout);
			},
		);
	});
});
