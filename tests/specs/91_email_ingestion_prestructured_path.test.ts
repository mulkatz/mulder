import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const STORAGE_DIR = resolve(ROOT, '.local/storage');
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const EXTRACTED_STORAGE_DIR = resolve(STORAGE_DIR, 'extracted');
const SEGMENTS_STORAGE_DIR = resolve(STORAGE_DIR, 'segments');

let tmpDir: string;
let emlFile: string;
let relatedEmlFile: string;
let fakeEmlFile: string;
let fakeMsgFile: string;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;
let pgAvailable = false;

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
	});
	if ((result.status ?? 1) !== 0) {
		throw new Error(
			`Build failed in ${packageDir}:\n${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`,
		);
	}
}

function runCli(args: string[], timeout = 180_000): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI_DIST, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_CONFIG: EXAMPLE_CONFIG,
			MULDER_LOG_LEVEL: 'silent',
			NODE_ENV: 'test',
			PGPASSWORD: db.TEST_PG_PASSWORD,
		},
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function emlContent(input: { messageId: string; references?: string; inReplyTo?: string; subject: string }): string {
	const attachment = Buffer.from('Attachment note for email ingestion.\n', 'utf-8').toString('base64');
	return [
		`From: Alice Example <alice@example.com>`,
		`To: Bob Example <bob@example.com>`,
		`Cc: Case Desk <case-desk@example.com>`,
		`Reply-To: Alice Example <alice@example.com>`,
		`Date: Fri, 01 May 2026 10:00:00 +0000`,
		`Message-ID: <${input.messageId}>`,
		input.inReplyTo ? `In-Reply-To: <${input.inReplyTo}>` : null,
		input.references ? `References: <${input.references}>` : null,
		`Subject: ${input.subject}`,
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="mulder-boundary"',
		'',
		'--mulder-boundary',
		'Content-Type: text/plain; charset="utf-8"',
		'',
		'This is the deterministic email body for Spec 91.',
		'',
		'--mulder-boundary',
		'Content-Type: text/plain; name="attachment-note.txt"',
		'Content-Disposition: attachment; filename="attachment-note.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		attachment,
		'--mulder-boundary--',
		'',
	]
		.filter((line): line is string => line !== null)
		.join('\r\n');
}

function cleanState(): void {
	db.runSql(
		[
			'DELETE FROM monthly_budget_reservations',
			'DELETE FROM jobs',
			'DELETE FROM pipeline_run_sources',
			'DELETE FROM pipeline_runs',
			'DELETE FROM source_steps',
			'DELETE FROM chunks',
			'DELETE FROM story_entities',
			'DELETE FROM entity_edges',
			'DELETE FROM entity_aliases',
			'DELETE FROM entities',
			'DELETE FROM stories',
			'DELETE FROM sources',
		].join('; '),
	);
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sourceIdForFilename(filename: string): string {
	return db.runSql(`SELECT id FROM sources WHERE filename = ${sqlLiteral(filename)} ORDER BY created_at DESC LIMIT 1;`);
}

function resetStorage(): void {
	for (const snapshot of [rawSnapshot, extractedSnapshot, segmentsSnapshot]) {
		if (snapshot) {
			cleanStorageDirSince(snapshot);
		}
	}
}

function storyMetadataForSource(sourceId: string): Record<string, unknown> {
	const uri = db.runSql(`SELECT gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} LIMIT 1;`);
	return JSON.parse(readFileSync(resolve(STORAGE_DIR, uri), 'utf-8')) as Record<string, unknown>;
}

function storyMarkdownForSource(sourceId: string): string {
	const uri = db.runSql(`SELECT gcs_markdown_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} LIMIT 1;`);
	return readFileSync(resolve(STORAGE_DIR, uri), 'utf-8');
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-91-'));
	emlFile = join(tmpDir, 'message.eml');
	relatedEmlFile = join(tmpDir, 'reply.eml');
	fakeEmlFile = join(tmpDir, 'fake.eml');
	fakeMsgFile = join(tmpDir, 'fake.msg');
	writeFileSync(emlFile, emlContent({ messageId: 'root@example.com', subject: 'Spec 91 Email' }), 'utf-8');
	writeFileSync(
		relatedEmlFile,
		emlContent({
			messageId: 'reply@example.com',
			references: 'root@example.com',
			inReplyTo: 'root@example.com',
			subject: 'Re: Spec 91 Email',
		}),
		'utf-8',
	);
	writeFileSync(fakeEmlFile, 'This is plain text renamed to an email file.\n', 'utf-8');
	writeFileSync(fakeMsgFile, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]));

	rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
	extractedSnapshot = snapshotStorageDir(EXTRACTED_STORAGE_DIR);
	segmentsSnapshot = snapshotStorageDir(SEGMENTS_STORAGE_DIR);

	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);

	pgAvailable = db.isPgAvailable();
	if (pgAvailable) {
		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], 300_000);
		expect(migrate.exitCode, `${migrate.stdout}\n${migrate.stderr}`).toBe(0);
	}
}, 600_000);

beforeEach(() => {
	if (!pgAvailable) return;
	cleanState();
	resetStorage();
});

afterAll(() => {
	try {
		if (pgAvailable) {
			cleanState();
			resetStorage();
		}
	} catch {
		// Ignore cleanup failures.
	}
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe('Spec 91 — Email Ingestion on the Pre-Structured Path', () => {
	it('QA-01/04: CLI dry-run accepts valid EML and rejects arbitrary text renamed to EML', () => {
		const valid = runCli(['ingest', '--dry-run', emlFile]);
		expect(valid.exitCode, `${valid.stdout}\n${valid.stderr}`).toBe(0);
		expect(valid.stdout).toContain('Type');
		expect(valid.stdout).toMatch(/\bemail\b/);
		expect(valid.stdout).toMatch(/\b0\b/);

		const invalid = runCli(['ingest', '--dry-run', fakeEmlFile]);
		expect(invalid.exitCode).not.toBe(0);
		expect(`${invalid.stdout}\n${invalid.stderr}`).toMatch(/invalid|unsupported|email|RFC 822/i);
	});

	it('QA-05: MSG detection rejects arbitrary compound-looking binaries before source creation', () => {
		const result = runCli(['ingest', '--dry-run', fakeMsgFile]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/invalid|unsupported|msg|email/i);
	});

	it('QA-03/08/09/11/12/15: EML ingest and extract persist metadata, story hints, and child attachments', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', emlFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(emlFile));
		const sourceRow = db
			.runSql(
				`SELECT source_type::text, page_count, has_native_text, native_text_ratio, storage_path, format_metadata->>'media_type', format_metadata->>'email_format', format_metadata->>'subject' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(sourceRow).toEqual([
			'email',
			'0',
			'f',
			'0',
			`raw/${sourceId}/original.eml`,
			'message/rfc822',
			'eml',
			'Spec 91 Email',
		]);

		const duplicate = runCli(['ingest', emlFile]);
		expect(duplicate.exitCode, `${duplicate.stdout}\n${duplicate.stderr}`).toBe(0);
		expect(duplicate.stdout).toMatch(/duplicate/i);
		expect(db.runSql(`SELECT COUNT(*) FROM sources WHERE filename = ${sqlLiteral(basename(emlFile))};`)).toBe('1');

		const extract = runCli(['extract', sourceId]);
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`),
		).toBe('completed');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);

		const markdown = storyMarkdownForSource(sourceId);
		expect(markdown).toContain('## Headers');
		expect(markdown).toContain('This is the deterministic email body for Spec 91.');
		expect(markdown).toContain('## Attachments');
		expect(markdown).toContain('## Email Entity Hints');
		expect(markdown).toContain('alice@example.com');
		expect(markdown).toContain('attachment-note.txt');

		const metadata = storyMetadataForSource(sourceId);
		expect(metadata.source_type).toBe('email');
		expect(metadata.email_format).toBe('eml');
		expect(metadata.thread_id).toEqual(expect.any(String));
		expect(metadata.entity_hints).toEqual(expect.arrayContaining([expect.objectContaining({ field_name: 'from' })]));

		const child = db
			.runSql(
				`SELECT source_type::text, parent_source_id::text, storage_path FROM sources WHERE parent_source_id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(child[0]).toBe('text');
		expect(child[1]).toBe(sourceId);
		expect(child[2]).toMatch(/^raw\/[0-9a-f-]+\/original\.txt$/);
		expect(existsSync(resolve(STORAGE_DIR, child[2]))).toBe(true);
	});

	it('QA-10: thread ID is deterministic across References/In-Reply-To conversations', () => {
		if (!pgAvailable) return;

		for (const file of [emlFile, relatedEmlFile]) {
			const ingest = runCli(['ingest', file]);
			expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
			const sourceId = sourceIdForFilename(basename(file));
			const extract = runCli(['extract', sourceId]);
			expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		}

		const threadIds = db
			.runSql("SELECT DISTINCT metadata->>'thread_id' FROM stories ORDER BY 1;")
			.split('\n')
			.filter(Boolean);
		expect(threadIds).toHaveLength(1);
	});
});
