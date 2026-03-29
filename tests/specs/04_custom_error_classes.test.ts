import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 04: Custom Error Classes with Typed Error Codes
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests import from `@mulder/core` barrel — the public API surface.
 * No imports from packages/core/src/ internals.
 */

describe('Spec 04: Custom Error Classes', () => {
	let MulderError: any;
	let ConfigError: any;
	let PipelineError: any;
	let DatabaseError: any;
	let ExternalServiceError: any;
	let ConfigValidationError: any;
	let isMulderError: (error: unknown) => boolean;
	let isRetryableError: (error: unknown) => boolean;
	let CONFIG_ERROR_CODES: Record<string, string>;
	let PIPELINE_ERROR_CODES: Record<string, string>;
	let DATABASE_ERROR_CODES: Record<string, string>;
	let EXTERNAL_SERVICE_ERROR_CODES: Record<string, string>;
	let loadConfig: (path?: string) => unknown;

	let tmpDir: string;

	beforeAll(async () => {
		const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
		MulderError = core.MulderError;
		ConfigError = core.ConfigError;
		PipelineError = core.PipelineError;
		DatabaseError = core.DatabaseError;
		ExternalServiceError = core.ExternalServiceError;
		ConfigValidationError = core.ConfigValidationError;
		isMulderError = core.isMulderError;
		isRetryableError = core.isRetryableError;
		CONFIG_ERROR_CODES = core.CONFIG_ERROR_CODES;
		PIPELINE_ERROR_CODES = core.PIPELINE_ERROR_CODES;
		DATABASE_ERROR_CODES = core.DATABASE_ERROR_CODES;
		EXTERNAL_SERVICE_ERROR_CODES = core.EXTERNAL_SERVICE_ERROR_CODES;
		loadConfig = core.loadConfig;

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-04-'));
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	/** Helper: write YAML to a temp file and return its path */
	function writeTempConfig(yaml: string, filename = 'mulder.config.yaml'): string {
		const filePath = join(tmpDir, filename);
		writeFileSync(filePath, yaml, 'utf-8');
		return filePath;
	}

	// ─── QA-01: MulderError has code and context ───

	describe('QA-01: MulderError has code and context', () => {
		it('stores code and context properties and is instanceof Error', () => {
			const error = new MulderError('msg', 'CONFIG_INVALID', {
				context: { path: 'x' },
			});

			expect(error.code).toBe('CONFIG_INVALID');
			expect(error.context).toBeDefined();
			expect(error.context.path).toBe('x');
			expect(error).toBeInstanceOf(Error);
		});
	});

	// ─── QA-02: Domain subclasses are instanceof MulderError ───

	describe('QA-02: Domain subclasses are instanceof MulderError', () => {
		it('ConfigError, PipelineError, DatabaseError, ExternalServiceError are all instanceof MulderError and Error', () => {
			const configErr = new ConfigError('cfg', 'CONFIG_NOT_FOUND');
			const pipelineErr = new PipelineError('pipe', 'PIPELINE_STEP_FAILED');
			const dbErr = new DatabaseError('db', 'DB_CONNECTION_FAILED');
			const extErr = new ExternalServiceError('ext', 'EXT_VERTEX_AI_FAILED');

			for (const err of [configErr, pipelineErr, dbErr, extErr]) {
				expect(err).toBeInstanceOf(MulderError);
				expect(err).toBeInstanceOf(Error);
			}
		});
	});

	// ─── QA-03: Subclasses enforce typed codes ───

	describe('QA-03: Subclasses enforce typed codes', () => {
		it('ConfigError stores the correct typed code value', () => {
			const error = new ConfigError('msg', 'CONFIG_NOT_FOUND');
			expect(error.code).toBe('CONFIG_NOT_FOUND');
		});

		it('PipelineError stores the correct typed code value', () => {
			const error = new PipelineError('msg', 'PIPELINE_STEP_FAILED');
			expect(error.code).toBe('PIPELINE_STEP_FAILED');
		});

		it('DatabaseError stores the correct typed code value', () => {
			const error = new DatabaseError('msg', 'DB_CONNECTION_FAILED');
			expect(error.code).toBe('DB_CONNECTION_FAILED');
		});

		it('ExternalServiceError stores the correct typed code value', () => {
			const error = new ExternalServiceError('msg', 'EXT_DOCUMENT_AI_FAILED');
			expect(error.code).toBe('EXT_DOCUMENT_AI_FAILED');
		});
	});

	// ─── QA-04: ConfigValidationError extends ConfigError ───

	describe('QA-04: ConfigValidationError extends ConfigError', () => {
		it('is instanceof ConfigError and MulderError with code CONFIG_INVALID', () => {
			const error = new ConfigValidationError([{ path: 'a.b', message: 'bad', code: 'invalid_type' }]);

			expect(error).toBeInstanceOf(ConfigError);
			expect(error).toBeInstanceOf(MulderError);
			expect(error.code).toBe('CONFIG_INVALID');
		});
	});

	// ─── QA-05: Error cause chain works ───

	describe('QA-05: Error cause chain works', () => {
		it('preserves cause through the error chain', () => {
			const rootCause = new Error('root');
			const error = new PipelineError('step failed', 'PIPELINE_STEP_FAILED', {
				cause: rootCause,
			});

			expect(error.cause).toBeInstanceOf(Error);
			expect((error.cause as Error).message).toBe('root');
		});
	});

	// ─── QA-06: isMulderError type guard ───

	describe('QA-06: isMulderError type guard', () => {
		it('returns true for MulderError and false for plain Error', () => {
			const mulderErr = new MulderError('test', 'CONFIG_INVALID');
			const plainErr = new Error('plain');

			expect(isMulderError(mulderErr)).toBe(true);
			expect(isMulderError(plainErr)).toBe(false);
		});

		it('returns true for domain subclasses', () => {
			const configErr = new ConfigError('cfg', 'CONFIG_NOT_FOUND');
			expect(isMulderError(configErr)).toBe(true);
		});
	});

	// ─── QA-07: isRetryableError identifies retryable errors ───

	describe('QA-07: isRetryableError identifies retryable errors', () => {
		it('returns true for ExternalServiceError', () => {
			const extErr = new ExternalServiceError('ext', 'EXT_STORAGE_FAILED');
			expect(isRetryableError(extErr)).toBe(true);
		});

		it('returns true for PipelineError with code PIPELINE_RATE_LIMITED', () => {
			const rateLimitedErr = new PipelineError('rate limited', 'PIPELINE_RATE_LIMITED');
			expect(isRetryableError(rateLimitedErr)).toBe(true);
		});

		it('returns false for ConfigError', () => {
			const configErr = new ConfigError('cfg', 'CONFIG_NOT_FOUND');
			expect(isRetryableError(configErr)).toBe(false);
		});
	});

	// ─── QA-08: Error codes are exported as constants ───

	describe('QA-08: Error codes are exported as constants', () => {
		it('CONFIG_ERROR_CODES contains expected keys', () => {
			expect(CONFIG_ERROR_CODES).toBeDefined();
			expect(CONFIG_ERROR_CODES.CONFIG_NOT_FOUND).toBe('CONFIG_NOT_FOUND');
			expect(CONFIG_ERROR_CODES.CONFIG_INVALID).toBe('CONFIG_INVALID');
		});

		it('PIPELINE_ERROR_CODES contains expected keys', () => {
			expect(PIPELINE_ERROR_CODES).toBeDefined();
			expect(PIPELINE_ERROR_CODES.PIPELINE_SOURCE_NOT_FOUND).toBe('PIPELINE_SOURCE_NOT_FOUND');
			expect(PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS).toBe('PIPELINE_WRONG_STATUS');
			expect(PIPELINE_ERROR_CODES.PIPELINE_STEP_FAILED).toBe('PIPELINE_STEP_FAILED');
			expect(PIPELINE_ERROR_CODES.PIPELINE_RATE_LIMITED).toBe('PIPELINE_RATE_LIMITED');
		});

		it('DATABASE_ERROR_CODES contains expected keys', () => {
			expect(DATABASE_ERROR_CODES).toBeDefined();
			expect(DATABASE_ERROR_CODES.DB_CONNECTION_FAILED).toBe('DB_CONNECTION_FAILED');
			expect(DATABASE_ERROR_CODES.DB_MIGRATION_FAILED).toBe('DB_MIGRATION_FAILED');
		});

		it('EXTERNAL_SERVICE_ERROR_CODES contains expected keys', () => {
			expect(EXTERNAL_SERVICE_ERROR_CODES).toBeDefined();
			expect(EXTERNAL_SERVICE_ERROR_CODES.EXT_DOCUMENT_AI_FAILED).toBe('EXT_DOCUMENT_AI_FAILED');
			expect(EXTERNAL_SERVICE_ERROR_CODES.EXT_VERTEX_AI_FAILED).toBe('EXT_VERTEX_AI_FAILED');
			expect(EXTERNAL_SERVICE_ERROR_CODES.EXT_STORAGE_FAILED).toBe('EXT_STORAGE_FAILED');
		});
	});

	// ─── QA-09: Error name property is set correctly ───

	describe('QA-09: Error name property is set correctly', () => {
		it('MulderError.name is "MulderError"', () => {
			const error = new MulderError('msg', 'CONFIG_INVALID');
			expect(error.name).toBe('MulderError');
		});

		it('ConfigError.name is "ConfigError"', () => {
			const error = new ConfigError('msg', 'CONFIG_NOT_FOUND');
			expect(error.name).toBe('ConfigError');
		});

		it('PipelineError.name is "PipelineError"', () => {
			const error = new PipelineError('msg', 'PIPELINE_STEP_FAILED');
			expect(error.name).toBe('PipelineError');
		});

		it('DatabaseError.name is "DatabaseError"', () => {
			const error = new DatabaseError('msg', 'DB_CONNECTION_FAILED');
			expect(error.name).toBe('DatabaseError');
		});

		it('ExternalServiceError.name is "ExternalServiceError"', () => {
			const error = new ExternalServiceError('msg', 'EXT_VERTEX_AI_FAILED');
			expect(error.name).toBe('ExternalServiceError');
		});
	});

	// ─── QA-10: Existing config loader still works ───

	describe('QA-10: Existing config loader still works', () => {
		it('loadConfig with invalid config still throws ConfigValidationError with .issues populated', () => {
			const invalidYaml = `
project:
  name: 123
`;
			const configPath = writeTempConfig(invalidYaml, 'qa10-invalid.yaml');

			expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);

			try {
				loadConfig(configPath);
			} catch (error: unknown) {
				expect(error).toBeInstanceOf(ConfigValidationError);
				const err = error as { issues?: Array<{ path: string; message: string }> };
				expect(err.issues).toBeDefined();
				expect(Array.isArray(err.issues)).toBe(true);
				expect(err.issues?.length).toBeGreaterThan(0);
			}
		});

		it('ConfigValidationError is backward compatible — instanceof ConfigError and MulderError', () => {
			const invalidYaml = `
project:
  name: 123
`;
			const configPath = writeTempConfig(invalidYaml, 'qa10-compat.yaml');

			try {
				loadConfig(configPath);
			} catch (error: unknown) {
				expect(error).toBeInstanceOf(ConfigValidationError);
				expect(error).toBeInstanceOf(ConfigError);
				expect(error).toBeInstanceOf(MulderError);
				expect(error).toBeInstanceOf(Error);
			}
		});
	});
});
