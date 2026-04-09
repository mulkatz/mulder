/**
 * Black-box QA tests for Spec 48: Layout-to-Markdown Converter.
 *
 * Each test maps to one QA condition from §5 or one CLI case from §5b
 * of docs/specs/48_layout_to_markdown.spec.md. Tests exercise the system
 * exclusively through public boundaries:
 *
 *   1. The exported `layoutToMarkdown` and `executeExtract` functions from
 *      the built `@mulder/pipeline` dist barrel.
 *   2. The `mulder extract` CLI via `spawnSync` against apps/cli/dist.
 *   3. The filesystem (dev-mode storage under .local/storage/extracted/).
 *   4. Fixture JSON and golden Markdown files committed to the repo.
 *
 * No imports from packages/*|/src, apps/*|/src, or src/. Dist-barrel only.
 *
 * Infra dependencies:
 *   - A running `mulder-pg-test` PostgreSQL container (same as spec 19).
 *     QA conditions that need the DB are gated on `pgAvailable`; when the
 *     container is down they are skipped with a clear message instead of
 *     failing the whole suite.
 *   - Built `apps/cli/dist/index.js` and `packages/pipeline/dist/index.js`.
 *     The implementation agent runs `pnpm turbo run build` before QA.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const PIPELINE_DIST = resolve(ROOT, 'packages/pipeline/dist/index.js');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');

const FIXTURE_EXTRACTED_DIR = resolve(ROOT, 'fixtures/extracted');
const GOLDEN_DIR = resolve(ROOT, 'eval/golden/layout-markdown');
const FIXTURE_RAW_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_RAW_DIR, 'native-text-sample.pdf');
const EXTRACTED_STORAGE_DIR = resolve(ROOT, '.local/storage/extracted');

const TMP_DIR = '/tmp/qa-48';

const FIXTURE_NAMES = [
	'native-text-sample',
	'multi-column-sample',
	'table-layout-sample',
	'scanned-sample',
	'mixed-language-sample',
] as const;

// ---------------------------------------------------------------------------
// Docker / PG helpers (shared with spec 19 container)
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
		{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 90_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

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

// ---------------------------------------------------------------------------
// Black-box imports from built dist barrels
// ---------------------------------------------------------------------------

// These are bound in beforeAll. Typed as `any` on purpose — the tests only
// exercise the documented public contract from the spec, not the source
// types.
/* eslint-disable @typescript-eslint/no-explicit-any */
let layoutToMarkdown: (layout: any) => string;
let executeExtract: (input: any, config: any, services: any, pool: any, logger: any) => Promise<any>;
let createServiceRegistry: (config: any, logger: any) => any;
let loadConfig: (path?: string) => any;
let createLogger: (opts?: any) => any;
let getWorkerPool: (cfg: any) => any;
let closeAllPools: () => Promise<void>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// In-memory fixture builders for §5 conditions that need crafted inputs
// ---------------------------------------------------------------------------

type Block = { text: string; type: string; confidence: number };
type Page = { pageNumber: number; method: string; confidence: number; text: string; blocks?: Block[] };

function doc(pages: Page[], sourceId = 'test-in-memory'): Record<string, unknown> {
	return {
		sourceId,
		pageCount: pages.length,
		primaryMethod: 'native',
		extractedAt: '2026-04-09T00:00:00.000Z',
		pages,
		metadata: { visionFallbackCount: 0, visionFallbackCapped: false },
	};
}

function page(blocks: Block[], pageNumber = 1): Page {
	return {
		pageNumber,
		method: 'native',
		confidence: 0.99,
		text: blocks.map((b) => b.text).join('\n'),
		blocks,
	};
}

function block(type: string, text: string, confidence = 0.99): Block {
	return { text, type, confidence };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Spec 48 — Layout-to-Markdown Converter', () => {
	let pgAvailable = false;

	beforeAll(async () => {
		const pipeline = await import(PIPELINE_DIST);
		layoutToMarkdown = pipeline.layoutToMarkdown;
		executeExtract = pipeline.executeExtract;

		const core = await import(CORE_DIST);
		createServiceRegistry = core.createServiceRegistry;
		loadConfig = core.loadConfig;
		createLogger = core.createLogger;
		getWorkerPool = core.getWorkerPool;
		closeAllPools = core.closeAllPools;

		expect(typeof layoutToMarkdown).toBe('function');
		expect(typeof executeExtract).toBe('function');

		pgAvailable = isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: mulder-pg-test container not running — QA-10, QA-11, QA-12 and CLI-01..06 will be skipped.\n' +
					'  Start with: docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
		} else {
			// Ensure schema is migrated (idempotent — matches spec 19 pattern).
			const migrate = runCli(['db', 'migrate', resolve(ROOT, 'mulder.config.example.yaml')]);
			if (migrate.exitCode !== 0) {
				throw new Error(`Migration failed: ${migrate.stdout} ${migrate.stderr}`);
			}
		}

		if (existsSync(TMP_DIR)) {
			rmSync(TMP_DIR, { recursive: true, force: true });
		}
		mkdirSync(TMP_DIR, { recursive: true });
	});

	afterAll(() => {
		if (existsSync(TMP_DIR)) {
			rmSync(TMP_DIR, { recursive: true, force: true });
		}
		if (pgAvailable) {
			try {
				cleanTestData();
				cleanExtractedStorage();
			} catch {
				// ignore
			}
		}
	});

	// ─── QA-01: Converter is a pure function ───
	// Same input → byte-identical output, no input mutation.
	it('QA-01: layoutToMarkdown is pure and does not mutate its input', () => {
		for (const name of FIXTURE_NAMES) {
			const layoutPath = join(FIXTURE_EXTRACTED_DIR, name, 'layout.json');
			const raw = readFileSync(layoutPath, 'utf-8');
			const layout = JSON.parse(raw);
			const snapshot = structuredClone(layout);

			const out1 = layoutToMarkdown(layout);
			const out2 = layoutToMarkdown(layout);

			expect(out1).toBe(out2);
			expect(layout).toEqual(snapshot);
		}
	});

	// ─── QA-02: Heading blocks render as # headings ───
	// Spec §5 QA-02: "the output contains `# Test Heading` on its own line,
	// followed by a blank line." The "blank line" is the inter-block
	// separator (§4.3), so we verify it by giving the heading a
	// following block. A trailing newline at document end is normalized
	// separately (§4.1) and does not count as a blank line.
	it('QA-02: a heading block renders as "# text" on its own line with a blank line before the next block', () => {
		const layout = doc([
			page([block('heading', 'Test Heading'), block('paragraph', 'Body text follows.')]),
		]);
		const md = layoutToMarkdown(layout);

		// "# Test Heading" appears on its own line.
		const lines = md.split('\n');
		expect(lines).toContain('# Test Heading');

		// Find the heading line index and confirm the very next line is
		// blank (i.e., a blank line separates the heading from the next
		// content line).
		const headingIdx = lines.findIndex((l) => l === '# Test Heading');
		expect(headingIdx).toBeGreaterThanOrEqual(0);
		expect(lines[headingIdx + 1] ?? '').toBe('');

		// And the next non-empty line is the body paragraph.
		expect(lines.slice(headingIdx + 2).find((l) => l.length > 0)).toBe('Body text follows.');
	});

	// ─── QA-03: Paragraph blocks render with paragraph breaks ───
	it('QA-03: a paragraph containing \\n\\n splits into two separate paragraphs', () => {
		const layout = doc([page([block('paragraph', 'First para.\n\nSecond para.')])]);
		const md = layoutToMarkdown(layout);

		expect(md).toContain('First para.');
		expect(md).toContain('Second para.');

		// Both paragraphs appear as their own blocks separated by >= 1 blank
		// line, and neither has leading/trailing whitespace on the content line.
		expect(md).toMatch(/(^|\n)First para\.\n/);
		expect(md).toMatch(/\nSecond para\.(\n|$)/);
		// There is a blank line somewhere between them.
		const idx1 = md.indexOf('First para.');
		const idx2 = md.indexOf('Second para.');
		expect(idx1).toBeGreaterThanOrEqual(0);
		expect(idx2).toBeGreaterThan(idx1);
		expect(md.slice(idx1, idx2)).toContain('\n\n');
	});

	// ─── QA-04: Tables render as GFM tables ───
	// Uses the real table-layout-sample fixture which contains two table blocks.
	it('QA-04: a well-formed table block renders as a valid GFM table', () => {
		const layoutPath = join(FIXTURE_EXTRACTED_DIR, 'table-layout-sample', 'layout.json');
		const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
		const md = layoutToMarkdown(layout);

		// Header row from the fixture data.
		expect(md).toContain('| Bundesland | Anzahl | Anteil | Verifiziert |');
		// GFM separator row with 4 columns.
		expect(md).toMatch(/\|\s*---\s*\|\s*---\s*\|\s*---\s*\|\s*---\s*\|/);
		// At least one data row from the table.
		expect(md).toContain('| Bayern | 142 | 18,3% | 67 |');
		// Structural sanity: the separator row must come right after the header
		// (a GFM parser requires this).
		const headerIdx = md.indexOf('| Bundesland | Anzahl | Anteil | Verifiziert |');
		const nextNewline = md.indexOf('\n', headerIdx);
		const lineAfter = md.slice(nextNewline + 1, md.indexOf('\n', nextNewline + 1));
		expect(lineAfter).toMatch(/^\|\s*---/);
	});

	// ─── QA-05: Malformed table falls back to a fenced code block ───
	it('QA-05: a malformed table falls back to a code block and preserves content', () => {
		// Single-row "table" (no rows → fails the 2+ rows rule per §4.3).
		const badText = 'OnlyOneLine | OneField | NoDataRows';
		const layout = doc([page([block('table', badText)])]);
		const md = layoutToMarkdown(layout);

		// The original text must be preserved somewhere in the output.
		expect(md).toContain(badText);
		// It must live inside a fenced code block (triple backticks).
		expect(md).toContain('```');
		// The fence must wrap the text: look for ``` ... badText ... ```
		const fencePattern = /```[a-z]*\n([\s\S]*?)\n```/;
		const match = md.match(fencePattern);
		expect(match).not.toBeNull();
		if (match) {
			expect(match[1]).toContain(badText);
		}
	});

	// ─── QA-06: Header and footer blocks are filtered out ───
	it('QA-06: header and footer blocks are not present in the output', () => {
		const layout = doc([
			page([
				block('header', 'Page 1'),
				block('paragraph', 'Real content here.'),
				block('footer', 'Confidential'),
			]),
		]);
		const md = layoutToMarkdown(layout);

		expect(md).not.toContain('Page 1');
		expect(md).not.toContain('Confidential');
		expect(md).toContain('Real content here.');
	});

	// ─── QA-07: Page boundaries render as horizontal rules ───
	it('QA-07: adjacent pages are separated by a horizontal rule, with none before first or after last', () => {
		const layout = doc([
			page([block('paragraph', 'Page one content.')], 1),
			page([block('paragraph', 'Page two content.')], 2),
		]);
		const md = layoutToMarkdown(layout);

		// Contains the page separator between the two pages.
		expect(md).toContain('\n\n---\n\n');
		expect(md).toContain('Page one content.');
		expect(md).toContain('Page two content.');

		// The separator is between the two content blocks, in order.
		const idxOne = md.indexOf('Page one content.');
		const idxSep = md.indexOf('\n\n---\n\n');
		const idxTwo = md.indexOf('Page two content.');
		expect(idxOne).toBeLessThan(idxSep);
		expect(idxSep).toBeLessThan(idxTwo);

		// No leading --- (before first page) and no trailing --- (after last page).
		expect(md.trimStart().startsWith('---')).toBe(false);
		expect(md.trimEnd().endsWith('---')).toBe(false);
	});

	// ─── QA-08: Reading order is preserved ───
	it('QA-08: block text appears in the same order as the input', () => {
		const layout = doc([
			page([
				block('paragraph', 'ALPHA marker text'),
				block('paragraph', 'BRAVO marker text'),
				block('paragraph', 'CHARLIE marker text'),
			]),
		]);
		const md = layoutToMarkdown(layout);

		const idxAlpha = md.indexOf('ALPHA');
		const idxBravo = md.indexOf('BRAVO');
		const idxCharlie = md.indexOf('CHARLIE');

		expect(idxAlpha).toBeGreaterThanOrEqual(0);
		expect(idxBravo).toBeGreaterThan(idxAlpha);
		expect(idxCharlie).toBeGreaterThan(idxBravo);
	});

	// ─── QA-09: Golden fixtures match byte-for-byte ───
	it('QA-09: each fixture matches its committed golden markdown file', () => {
		const failures: Array<{ name: string; diff: string }> = [];

		for (const name of FIXTURE_NAMES) {
			const layoutPath = join(FIXTURE_EXTRACTED_DIR, name, 'layout.json');
			const goldenPath = join(GOLDEN_DIR, `${name}.md`);
			expect(existsSync(layoutPath), `fixture missing: ${layoutPath}`).toBe(true);
			expect(existsSync(goldenPath), `golden missing: ${goldenPath}`).toBe(true);

			const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
			const golden = readFileSync(goldenPath, 'utf-8');
			const actual = layoutToMarkdown(layout);

			// Normalize a single optional trailing newline on both sides so
			// `content` vs `content\n` compare equal.
			const norm = (s: string) => (s.endsWith('\n') ? s : `${s}\n`);
			const a = norm(actual);
			const g = norm(golden);

			if (a !== g) {
				const firstDiff = (() => {
					for (let i = 0; i < Math.min(a.length, g.length); i++) {
						if (a[i] !== g[i]) {
							const ctx = (s: string, pos: number) =>
								JSON.stringify(s.slice(Math.max(0, pos - 20), pos + 20));
							return `at offset ${i}: actual=${ctx(a, i)} golden=${ctx(g, i)}`;
						}
					}
					return `length mismatch: actual=${a.length} golden=${g.length}`;
				})();
				failures.push({ name, diff: firstDiff });
			}
		}

		if (failures.length > 0) {
			const msg = failures.map((f) => `  ${f.name}: ${f.diff}`).join('\n');
			throw new Error(`${failures.length} golden mismatch(es):\n${msg}`);
		}
	});

	// ─── QA-10: Extract step writes layout.md alongside layout.json ───
	it.skipIf(!isPgAvailable())(
		'QA-10: executeExtract writes both layout.json and layout.md to storage',
		async () => {
			if (!pgAvailable) return;

			cleanTestData();
			cleanExtractedStorage();

			const sourceId = ingestNativeTextPdf();

			const config = loadConfig(resolve(ROOT, 'mulder.config.yaml'));
			const logger = createLogger({ level: 'silent' });
			const services = createServiceRegistry(config, logger);
			const pool = getWorkerPool(config.gcp.cloud_sql);

			try {
				const result = await executeExtract({ sourceId, force: false }, config, services, pool, logger);
				expect(result.status).not.toBe('failed');

				const layoutJson = join(EXTRACTED_STORAGE_DIR, sourceId, 'layout.json');
				const layoutMd = join(EXTRACTED_STORAGE_DIR, sourceId, 'layout.md');

				expect(existsSync(layoutJson)).toBe(true);
				expect(existsSync(layoutMd)).toBe(true);

				const mdBuf = readFileSync(layoutMd);
				expect(mdBuf.length).toBeGreaterThan(0);
				// Valid UTF-8: round-trip must succeed and not contain the
				// Unicode replacement character (which indicates decode errors).
				const mdText = mdBuf.toString('utf-8');
				expect(mdText.length).toBeGreaterThan(0);
				expect(mdText).not.toContain('\uFFFD');
				// Sanity: no unresolved placeholder markers.
				expect(mdText).not.toContain('undefined\n');
				expect(mdText).not.toContain('[object Object]');
			} finally {
				await closeAllPools();
			}
		},
	);

	// ─── QA-11: Markdown write failure does not fail Extract ───
	// We wrap the dev services such that storage.upload() throws on any
	// path ending in `.md`. The spec guarantees this must not fail the
	// overall extract result.
	it.skipIf(!isPgAvailable())(
		'QA-11: a failing layout.md upload does not fail the extract step',
		async () => {
			if (!pgAvailable) return;

			cleanTestData();
			cleanExtractedStorage();

			const sourceId = ingestNativeTextPdf();

			const config = loadConfig(resolve(ROOT, 'mulder.config.yaml'));
			const logger = createLogger({ level: 'silent' });
			const realServices = createServiceRegistry(config, logger);
			const pool = getWorkerPool(config.gcp.cloud_sql);

			const realUpload = realServices.storage.upload.bind(realServices.storage);
			let mdUploadAttempted = false;
			const wrappedStorage = {
				...realServices.storage,
				upload: async (path: string, content: Buffer | string, contentType?: string) => {
					if (path.endsWith('.md')) {
						mdUploadAttempted = true;
						throw new Error('simulated markdown upload failure');
					}
					return realUpload(path, content, contentType);
				},
				download: realServices.storage.download.bind(realServices.storage),
				exists: realServices.storage.exists.bind(realServices.storage),
				list: realServices.storage.list.bind(realServices.storage),
				delete: realServices.storage.delete.bind(realServices.storage),
			};
			const wrappedServices = { ...realServices, storage: wrappedStorage };

			try {
				const result = await executeExtract(
					{ sourceId, force: false },
					config,
					wrappedServices,
					pool,
					logger,
				);

				// Extract must still succeed despite the .md upload failure.
				expect(result.status).toBe('success');
				// The .json must still have been written.
				expect(existsSync(join(EXTRACTED_STORAGE_DIR, sourceId, 'layout.json'))).toBe(true);
				// The attempt was actually made (otherwise the test proves nothing).
				expect(mdUploadAttempted).toBe(true);
				// And the .md file must NOT be present (since we sabotaged it).
				expect(existsSync(join(EXTRACTED_STORAGE_DIR, sourceId, 'layout.md'))).toBe(false);
			} finally {
				await closeAllPools();
			}
		},
	);

	// ─── QA-12: Extract idempotency preserves layout.md deterministically ───
	it.skipIf(!isPgAvailable())(
		'QA-12: re-running extract with --force produces byte-identical layout.md',
		() => {
			if (!pgAvailable) return;

			cleanTestData();
			cleanExtractedStorage();

			const sourceId = ingestNativeTextPdf();

			const first = runCli(['extract', sourceId]);
			expect(first.exitCode).toBe(0);
			const mdPath = join(EXTRACTED_STORAGE_DIR, sourceId, 'layout.md');
			expect(existsSync(mdPath)).toBe(true);
			const firstBytes = readFileSync(mdPath);

			const second = runCli(['extract', sourceId, '--force']);
			expect(second.exitCode).toBe(0);
			expect(existsSync(mdPath)).toBe(true);
			const secondBytes = readFileSync(mdPath);

			expect(secondBytes.equals(firstBytes)).toBe(true);

			// Also verify the converter is deterministic against the freshly
			// written JSON — re-running layoutToMarkdown on the current
			// layout.json must match the stored .md bytes.
			const layout = JSON.parse(
				readFileSync(join(EXTRACTED_STORAGE_DIR, sourceId, 'layout.json'), 'utf-8'),
			);
			const regenerated = layoutToMarkdown(layout);
			expect(regenerated).toBe(secondBytes.toString('utf-8'));
		},
	);

	// ─── QA-13: All five fixtures produce valid Markdown ───
	it('QA-13: all fixtures produce non-empty, valid UTF-8 Markdown with no placeholder leaks', () => {
		for (const name of FIXTURE_NAMES) {
			const layoutPath = join(FIXTURE_EXTRACTED_DIR, name, 'layout.json');
			const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
			const md = layoutToMarkdown(layout);

			expect(md.length, `${name}: empty output`).toBeGreaterThan(0);
			expect(md, `${name}: contains 'undefined'`).not.toContain('undefined');
			expect(md, `${name}: contains '[object Object]'`).not.toContain('[object Object]');
			// Round-trip through Buffer to prove it's UTF-8-clean.
			const roundtrip = Buffer.from(md, 'utf-8').toString('utf-8');
			expect(roundtrip).toBe(md);
			expect(md, `${name}: contains U+FFFD replacement char`).not.toContain('\uFFFD');
		}
	});

	// ═══════════════════════════════════════════════════════════════════════
	// §5b — CLI Test Matrix (6 cases)
	// ═══════════════════════════════════════════════════════════════════════

	describe('CLI matrix (§5b)', () => {
		// Shared source ID for CLI-01..CLI-03 and CLI-06. CLI-04 and CLI-05
		// don't need a pre-ingested source (CLI-04 is `--all`, CLI-05 fails
		// on the parent dir check before touching extract).
		let srcId: string | null = null;

		function ensureSource(): string {
			if (srcId && existsSync(join(EXTRACTED_STORAGE_DIR, srcId, 'layout.json'))) {
				return srcId;
			}
			cleanTestData();
			cleanExtractedStorage();
			srcId = ingestNativeTextPdf();
			return srcId;
		}

		// ─── CLI-01: plain extract writes layout.md in storage, no local file ───
		it.skipIf(!isPgAvailable())(
			'CLI-01: mulder extract <id> → exit 0, layout.md in storage, no local file',
			() => {
				if (!pgAvailable) return;
				const id = ensureSource();

				const result = runCli(['extract', id]);
				expect(result.exitCode).toBe(0);

				const storageMd = join(EXTRACTED_STORAGE_DIR, id, 'layout.md');
				expect(existsSync(storageMd)).toBe(true);

				// No --markdown-to → no file written to the local tmp dir.
				const stray = readdirSync(TMP_DIR).filter((f) => f.endsWith('.md'));
				expect(stray).toEqual([]);
			},
		);

		// ─── CLI-02: --markdown-to writes a local file matching storage ───
		it.skipIf(!isPgAvailable())(
			'CLI-02: --markdown-to writes a local file byte-identical to storage layout.md',
			() => {
				if (!pgAvailable) return;
				const id = ensureSource();

				const localPath = join(TMP_DIR, 'out.md');
				const result = runCli(['extract', id, '--markdown-to', localPath]);
				expect(result.exitCode).toBe(0);
				expect(existsSync(localPath)).toBe(true);

				const local = readFileSync(localPath);
				const storage = readFileSync(join(EXTRACTED_STORAGE_DIR, id, 'layout.md'));
				expect(local.equals(storage)).toBe(true);
			},
		);

		// ─── CLI-03: --force + --markdown-to produces same content as CLI-02 ───
		it.skipIf(!isPgAvailable())(
			'CLI-03: --force --markdown-to matches CLI-02 output (deterministic)',
			() => {
				if (!pgAvailable) return;
				const id = ensureSource();

				// CLI-02 output as reference.
				const cli02Path = join(TMP_DIR, 'out.md');
				if (!existsSync(cli02Path)) {
					const seed = runCli(['extract', id, '--markdown-to', cli02Path]);
					expect(seed.exitCode).toBe(0);
				}
				const ref = readFileSync(cli02Path);

				const out2Path = join(TMP_DIR, 'out2.md');
				const result = runCli(['extract', id, '--force', '--markdown-to', out2Path]);
				expect(result.exitCode).toBe(0);
				expect(existsSync(out2Path)).toBe(true);

				const actual = readFileSync(out2Path);
				expect(actual.equals(ref)).toBe(true);
			},
		);

		// ─── CLI-04: --all and --markdown-to are mutually exclusive ───
		it.skipIf(!isPgAvailable())(
			'CLI-04: --all --markdown-to exits non-zero with a mutual-exclusion error',
			() => {
				if (!pgAvailable) return;

				const manyPath = join(TMP_DIR, 'many.md');
				// Pre-clean the target so the assertion about "no file written"
				// is meaningful.
				if (existsSync(manyPath)) rmSync(manyPath);

				const result = runCli(['extract', '--all', '--markdown-to', manyPath]);
				expect(result.exitCode).not.toBe(0);

				const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
				expect(combined).toMatch(/markdown-to.*all|all.*markdown-to|mutually exclusive|cannot be used/);

				expect(existsSync(manyPath)).toBe(false);
			},
		);

		// ─── CLI-05: non-existent parent directory fails cleanly ───
		it.skipIf(!isPgAvailable())(
			'CLI-05: --markdown-to with a nonexistent parent dir exits non-zero',
			() => {
				if (!pgAvailable) return;
				const id = ensureSource();

				const badPath = '/nonexistent-parent-dir-qa48/out.md';
				const result = runCli(['extract', id, '--markdown-to', badPath]);
				expect(result.exitCode).not.toBe(0);

				const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
				expect(combined).toMatch(/parent|directory|nonexistent|does not exist|path|markdown-to/);

				expect(existsSync(badPath)).toBe(false);
			},
		);

		// ─── CLI-06: running CLI-02 twice yields byte-identical output ───
		it.skipIf(!isPgAvailable())(
			'CLI-06: running the same --markdown-to command twice yields identical bytes',
			() => {
				if (!pgAvailable) return;
				const id = ensureSource();

				const p = join(TMP_DIR, 'idem.md');
				if (existsSync(p)) rmSync(p);

				const first = runCli(['extract', id, '--markdown-to', p]);
				expect(first.exitCode).toBe(0);
				expect(existsSync(p)).toBe(true);
				const bytes1 = readFileSync(p);

				// Second run needs --force because the source is already extracted.
				const second = runCli(['extract', id, '--force', '--markdown-to', p]);
				expect(second.exitCode).toBe(0);
				expect(existsSync(p)).toBe(true);
				const bytes2 = readFileSync(p);

				expect(bytes2.equals(bytes1)).toBe(true);
			},
		);
	});
});
