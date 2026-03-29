import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 05: Logger Setup — Pino Structured JSON
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests import from `@mulder/core` barrel — the public API surface.
 * No imports from packages/core/src/ internals.
 *
 * Pino writes to file descriptors directly (via SonicBoom), not Node.js
 * streams. To capture output reliably, tests that inspect log output use
 * child processes with stdio pipe capture.
 */

describe('Spec 05: Logger Setup — Pino Structured JSON', () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-05-'));
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	/**
	 * Helper: run a script as a child process, capture both stdout and stderr.
	 * The script is written to a temp .mjs file and executed with node.
	 */
	function runScriptFull(
		scriptLines: string[],
		env: Record<string, string> = {},
	): { stdout: string; stderr: string; exitCode: number } {
		const scriptContent = scriptLines.join('\n');
		const scriptPath = join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
		writeFileSync(scriptPath, scriptContent, 'utf-8');

		const result = spawnSync('node', [scriptPath], {
			cwd: ROOT,
			env: { ...process.env, ...env },
			encoding: 'utf-8',
			timeout: 15000,
		});

		return {
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			exitCode: result.status ?? 1,
		};
	}

	/**
	 * Helper: parse newline-delimited JSON from a string.
	 */
	function parseJsonLines(output: string): Record<string, unknown>[] {
		return output
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((entry) => entry !== null);
	}

	/**
	 * Common script preamble: import core from dist.
	 */
	const importCore = `import { resolve } from "node:path";
const core = await import(resolve("${ROOT}", "packages/core/dist/index.js"));
const { createLogger, createChildLogger, withDuration, ConfigError } = core;`;

	// ─── QA-01: Logger produces structured JSON ───

	describe('QA-01: Logger produces structured JSON', () => {
		it('outputs valid JSON with level, time, and msg fields at info level', () => {
			const { stdout } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'logger.info("hello structured world");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stdout);
			expect(lines.length).toBeGreaterThanOrEqual(1);

			const entry = lines.find((l) => l.msg === 'hello structured world');
			expect(entry).toBeDefined();
			expect(entry).toHaveProperty('level');
			expect(entry).toHaveProperty('time');
			expect(entry).toHaveProperty('msg');
			expect(entry.msg).toBe('hello structured world');
		});
	});

	// ─── QA-02: Log level filtering works ───

	describe('QA-02: Log level filtering works', () => {
		it('only emits warn+ messages when MULDER_LOG_LEVEL=warn', () => {
			const { stdout } = runScriptFull(
				[
					importCore,
					'const logger = createLogger();',
					'logger.info("should not appear");',
					'logger.warn("should appear");',
					'await new Promise(r => setTimeout(r, 100));',
				],
				{ MULDER_LOG_LEVEL: 'warn' },
			);

			const lines = parseJsonLines(stdout);
			const infoLines = lines.filter((l) => l.msg === 'should not appear');
			const warnLines = lines.filter((l) => l.msg === 'should appear');

			expect(infoLines.length).toBe(0);
			expect(warnLines.length).toBe(1);
		});
	});

	// ─── QA-03: Child logger binds context ───

	describe('QA-03: Child logger binds context', () => {
		it('includes step and source_id fields in output JSON', () => {
			const { stdout } = runScriptFull([
				importCore,
				'const parent = createLogger();',
				'const child = createChildLogger(parent, { step: "enrich", source_id: "abc-123" });',
				'child.info("processing document");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stdout);
			const entry = lines.find((l) => l.msg === 'processing document');
			expect(entry).toBeDefined();
			expect(entry.step).toBe('enrich');
			expect(entry.source_id).toBe('abc-123');
		});
	});

	// ─── QA-04: MulderError serialization includes code and context ───

	describe('QA-04: MulderError serialization includes code and context', () => {
		it('err object in JSON output contains code, context, and type fields', () => {
			const { stdout } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'const error = new ConfigError("config missing", "CONFIG_NOT_FOUND", { context: { path: "/missing" } });',
				'logger.error({ err: error }, "failed to load config");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stdout);
			const entry = lines.find((l) => l.msg === 'failed to load config');
			expect(entry).toBeDefined();
			expect(entry.err).toBeDefined();
			expect(entry.err.code).toBe('CONFIG_NOT_FOUND');
			expect(entry.err.context).toBeDefined();
			expect(entry.err.context.path).toBe('/missing');
			expect(entry.err.type).toBeDefined();
			expect(typeof entry.err.type).toBe('string');
		});
	});

	// ─── QA-05: Sensitive fields are redacted ───

	describe('QA-05: Sensitive fields are redacted', () => {
		it('replaces api_key value with [Redacted]', () => {
			const { stdout } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'logger.info({ data: { api_key: "super-secret-key-123" } }, "request payload");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stdout);
			const entry = lines.find((l) => l.msg === 'request payload');
			expect(entry).toBeDefined();

			const raw = JSON.stringify(entry);
			expect(raw).not.toContain('super-secret-key-123');
			expect(entry.data.api_key).toBe('[Redacted]');
		});
	});

	// ─── QA-06: Duration helper logs elapsed time ───

	describe('QA-06: Duration helper logs elapsed time', () => {
		it('logs info-level entry with duration_ms as a number on success', () => {
			const { stdout } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'const result = await withDuration(logger, "timed operation", async () => {',
				'  await new Promise(r => setTimeout(r, 20));',
				'  return 42;',
				'});',
				'// Write the return value to stderr so we can check it without polluting stdout JSON',
				'process.stderr.write("RESULT:" + result + "\\n");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stdout);
			const durationEntry = lines.find((l) => typeof l.duration_ms === 'number');
			expect(durationEntry).toBeDefined();
			expect(durationEntry.duration_ms).toBeGreaterThanOrEqual(0);
			// Should be info level (level string "info" or numeric 30)
			const level = durationEntry.level;
			expect(level === 'info' || level === 30).toBe(true);
		});
	});

	// ─── QA-07: Duration helper logs on error ───

	describe('QA-07: Duration helper logs on error', () => {
		it('logs error-level entry with duration_ms and re-throws', () => {
			const { stdout, stderr, exitCode } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'try {',
				'  await withDuration(logger, "failing operation", async () => {',
				'    await new Promise(r => setTimeout(r, 10));',
				'    throw new Error("boom");',
				'  });',
				'} catch (e) {',
				'  // Write to stderr to confirm the error was re-thrown',
				'  process.stderr.write("CAUGHT:" + e.message + "\\n");',
				'}',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			// Verify the error was re-thrown
			expect(stderr).toContain('CAUGHT:boom');

			const lines = parseJsonLines(stdout);
			const errorEntry = lines.find(
				(l) => typeof l.duration_ms === 'number' && (l.level === 'error' || l.level === 50),
			);
			expect(errorEntry).toBeDefined();
			expect(errorEntry.duration_ms).toBeGreaterThanOrEqual(0);
		});
	});

	// ─── QA-08: Pretty transport targets stderr ───

	describe('QA-08: Pretty transport targets stderr', () => {
		it('outputs to stderr (not stdout) when MULDER_LOG_PRETTY=true', () => {
			const { stdout, stderr } = runScriptFull(
				[
					importCore,
					'const logger = createLogger();',
					'logger.info("pretty test message");',
					'await new Promise(r => setTimeout(r, 200));',
				],
				{
					MULDER_LOG_PRETTY: 'true',
					MULDER_LOG_LEVEL: 'info',
				},
			);

			// stdout should be empty — pretty output goes to stderr
			expect(stdout.trim()).toBe('');
			// stderr should contain the pretty message
			expect(stderr).toContain('pretty test message');
		});
	});

	// ─── QA-09: Package exports are accessible ───

	describe('QA-09: Package exports are accessible', () => {
		it('createLogger, createChildLogger, withDuration resolve from @mulder/core', async () => {
			const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));

			expect(typeof core.createLogger).toBe('function');
			expect(typeof core.createChildLogger).toBe('function');
			expect(typeof core.withDuration).toBe('function');

			// Logger type is a type-only export, but we can verify the Logger
			// interface is usable by checking that createLogger returns something
			// with standard pino methods
			const logger = core.createLogger();
			expect(typeof logger.info).toBe('function');
			expect(typeof logger.warn).toBe('function');
			expect(typeof logger.error).toBe('function');
			expect(typeof logger.debug).toBe('function');
		});
	});
});
