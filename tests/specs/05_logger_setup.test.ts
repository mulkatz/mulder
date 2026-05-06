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
			env: { ...process.env, MULDER_LOG_LEVEL: 'info', ...env },
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
	 * Shape of a parsed Pino log entry for type-safe access in tests.
	 */
	interface LogEntry {
		level?: string | number;
		time?: number;
		msg?: string;
		step?: string;
		source_id?: string;
		duration_ms?: number;
		err?: {
			code?: string;
			context?: Record<string, unknown>;
			type?: string;
			[key: string]: unknown;
		};
		data?: {
			api_key?: string;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	}

	/**
	 * Helper: parse newline-delimited JSON from a string.
	 */
	function parseJsonLines(output: string): LogEntry[] {
		return output
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line) as LogEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is LogEntry => entry !== null);
	}

	/**
	 * Helper: assert a value is defined and return it narrowed.
	 */
	function defined<T>(value: T | undefined, message?: string): T {
		expect(value, message).toBeDefined();
		return value as T;
	}

	/**
	 * Common script preamble: import core from dist.
	 */
	const importCore = `import { resolve } from "node:path";
const core = await import(resolve("${ROOT}", "packages/core/dist/index.js"));
const { createLogger, createChildLogger, withDuration, ConfigError } = core;`;

	// ─── QA-01: Logger produces structured JSON on stderr ───

	describe('QA-01: Logger produces structured JSON on stderr', () => {
		it('outputs valid JSON with level, time, and msg fields at info level', () => {
			const { stdout, stderr } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'logger.info("hello structured world");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			// Logs go to stderr, stdout stays empty for CLI piping
			expect(stdout).toBe('');
			const lines = parseJsonLines(stderr);
			expect(lines.length).toBeGreaterThanOrEqual(1);

			const entry = defined(lines.find((l) => l.msg === 'hello structured world'));
			expect(entry).toHaveProperty('level');
			expect(entry).toHaveProperty('time');
			expect(entry).toHaveProperty('msg');
			expect(entry.msg).toBe('hello structured world');
		});
	});

	// ─── QA-02: Log level filtering works ───

	describe('QA-02: Log level filtering works', () => {
		it('only emits warn+ messages when MULDER_LOG_LEVEL=warn', () => {
			const { stderr } = runScriptFull(
				[
					importCore,
					'const logger = createLogger();',
					'logger.info("should not appear");',
					'logger.warn("should appear");',
					'await new Promise(r => setTimeout(r, 100));',
				],
				{ MULDER_LOG_LEVEL: 'warn' },
			);

			const lines = parseJsonLines(stderr);
			const infoLines = lines.filter((l) => l.msg === 'should not appear');
			const warnLines = lines.filter((l) => l.msg === 'should appear');

			expect(infoLines.length).toBe(0);
			expect(warnLines.length).toBe(1);
		});

		it('does not allocate pretty transports or warn when silent loggers are created repeatedly', () => {
			const { stdout, stderr, exitCode } = runScriptFull(
				[
					importCore,
					'for (let i = 0; i < 20; i += 1) {',
					'  createLogger();',
					'}',
					'await new Promise(r => setTimeout(r, 100));',
				],
				{
					MULDER_LOG_LEVEL: 'silent',
					MULDER_LOG_PRETTY: 'true',
					NODE_OPTIONS: '--trace-warnings',
				},
			);

			expect(exitCode).toBe(0);
			expect(stdout).toBe('');
			expect(stderr).not.toContain('MaxListenersExceededWarning');
		});
	});

	// ─── QA-03: Child logger binds context ───

	describe('QA-03: Child logger binds context', () => {
		it('includes step and source_id fields in output JSON', () => {
			const { stderr } = runScriptFull([
				importCore,
				'const parent = createLogger();',
				'const child = createChildLogger(parent, { step: "enrich", source_id: "abc-123" });',
				'child.info("processing document");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stderr);
			const entry = defined(lines.find((l) => l.msg === 'processing document'));
			expect(entry.step).toBe('enrich');
			expect(entry.source_id).toBe('abc-123');
		});
	});

	// ─── QA-04: MulderError serialization includes code and context ───

	describe('QA-04: MulderError serialization includes code and context', () => {
		it('err object in JSON output contains code, context, and type fields', () => {
			const { stderr } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'const error = new ConfigError("config missing", "CONFIG_NOT_FOUND", { context: { path: "/missing" } });',
				'logger.error({ err: error }, "failed to load config");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stderr);
			const entry = defined(lines.find((l) => l.msg === 'failed to load config'));
			const err = defined(entry.err);
			expect(err.code).toBe('CONFIG_NOT_FOUND');
			const ctx = defined(err.context);
			expect(ctx.path).toBe('/missing');
			expect(err.type).toBeDefined();
			expect(typeof err.type).toBe('string');
		});
	});

	// ─── QA-05: Sensitive fields are redacted ───

	describe('QA-05: Sensitive fields are redacted', () => {
		it('replaces api_key value with [Redacted]', () => {
			const { stderr } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'logger.info({ data: { api_key: "super-secret-key-123" } }, "request payload");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			const lines = parseJsonLines(stderr);
			const entry = defined(lines.find((l) => l.msg === 'request payload'));
			const raw = JSON.stringify(entry);
			expect(raw).not.toContain('super-secret-key-123');
			expect(defined(entry.data).api_key).toBe('[Redacted]');
		});
	});

	// ─── QA-06: Duration helper logs elapsed time ───

	describe('QA-06: Duration helper logs elapsed time', () => {
		it('logs info-level entry with duration_ms as a number on success', () => {
			const { stdout, stderr } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'const result = await withDuration(logger, "timed operation", async () => {',
				'  await new Promise(r => setTimeout(r, 20));',
				'  return 42;',
				'});',
				'// Write the return value to stdout so we can verify it. Log JSON lives on stderr.',
				'process.stdout.write("RESULT:" + result + "\\n");',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			// The RESULT marker goes to stdout and proves the function ran.
			// The log lines live on stderr and do not pollute stdout.
			expect(stdout).toContain('RESULT:42');

			const lines = parseJsonLines(stderr);
			const durationEntry = defined(lines.find((l) => typeof l.duration_ms === 'number'));
			expect(durationEntry.duration_ms).toBeGreaterThanOrEqual(0);
			// Should be info level (level string "info" or numeric 30)
			const level = durationEntry.level;
			expect(level === 'info' || level === 30).toBe(true);
		});
	});

	// ─── QA-07: Duration helper logs on error ───

	describe('QA-07: Duration helper logs on error', () => {
		it('logs error-level entry with duration_ms and re-throws', () => {
			const { stdout, stderr } = runScriptFull([
				importCore,
				'const logger = createLogger();',
				'try {',
				'  await withDuration(logger, "failing operation", async () => {',
				'    await new Promise(r => setTimeout(r, 10));',
				'    throw new Error("boom");',
				'  });',
				'} catch (e) {',
				'  // Write the caught-error marker to stdout — log JSON is on stderr.',
				'  process.stdout.write("CAUGHT:" + e.message + "\\n");',
				'}',
				'await new Promise(r => setTimeout(r, 100));',
			]);

			// Verify the error was re-thrown (marker on stdout)
			expect(stdout).toContain('CAUGHT:boom');

			const lines = parseJsonLines(stderr);
			const errorEntry = defined(
				lines.find((l) => typeof l.duration_ms === 'number' && (l.level === 'error' || l.level === 50)),
			);
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

	// ─── QA-10: Stdout stays empty for all log levels ───

	describe('QA-10: Stdout stays empty for all log levels', () => {
		it('emits nothing to stdout across info/warn/error/debug + child + withDuration + MULDER_LOG_PRETTY', () => {
			// Log at every level, use a child logger, run withDuration — all paths
			// must write exclusively to stderr so CLI commands can rely on stdout
			// being reserved for their own output.
			const { stdout, stderr } = runScriptFull(
				[
					importCore,
					'const logger = createLogger();',
					'logger.debug("debug line");',
					'logger.info("info line");',
					'logger.warn("warn line");',
					'logger.error("error line");',
					'const child = createChildLogger(logger, { step: "qa-10" });',
					'child.info("child info line");',
					'await withDuration(logger, "timed op", async () => 1);',
					'await new Promise(r => setTimeout(r, 150));',
				],
				{
					MULDER_LOG_LEVEL: 'debug',
				},
			);

			// The central invariant: stdout is completely empty.
			expect(stdout).toBe('');

			// Sanity-check that logging actually happened on stderr.
			expect(stderr.length).toBeGreaterThan(0);
			const lines = parseJsonLines(stderr);
			expect(lines.some((l) => l.msg === 'info line')).toBe(true);
			expect(lines.some((l) => l.msg === 'child info line')).toBe(true);
		});

		it('emits nothing to stdout when MULDER_LOG_PRETTY=true', () => {
			const { stdout, stderr } = runScriptFull(
				[
					importCore,
					'const logger = createLogger();',
					'logger.info("pretty info line");',
					'await new Promise(r => setTimeout(r, 200));',
				],
				{
					MULDER_LOG_PRETTY: 'true',
					MULDER_LOG_LEVEL: 'info',
				},
			);

			// Pretty-printed output must also land on stderr.
			expect(stdout).toBe('');
			expect(stderr).toContain('pretty info line');
		});
	});
});
