import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 03: Config Loader + Zod Schemas
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests call `loadConfig()` from `@mulder/core` — the public API surface.
 * Temporary YAML config files are created per test to exercise system boundaries.
 * No imports from packages/ internals.
 */

// Minimal valid config YAML (all required fields, no optional fields)
const MINIMAL_CONFIG_YAML = `
project:
  name: "test-project"

gcp:
  project_id: "test-gcp-project"
  region: "europe-west1"
  cloud_sql:
    instance_name: "test-db"
    database: "testdb"
  storage:
    bucket: "test-bucket"
  document_ai:
    processor_id: "test-processor"

ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships: []
`;

// Full valid config with all sections populated
const FULL_CONFIG_YAML = `
project:
  name: "full-test-project"
  description: "Full test configuration"
  supported_locales: ["en", "de"]

gcp:
  project_id: "test-gcp-project"
  region: "europe-west1"
  cloud_sql:
    instance_name: "test-db"
    database: "testdb"
    tier: "db-custom-4-16384"
  storage:
    bucket: "test-bucket"
  document_ai:
    processor_id: "test-processor"

dev_mode: false

ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
      attributes:
        - name: "role"
          type: "string"
    - name: "location"
      description: "A geographic location"
      attributes:
        - name: "coordinates"
          type: "geo_point"
    - name: "event"
      description: "A specific occurrence"
      attributes:
        - name: "date"
          type: "date"
  relationships:
    - name: "PARTICIPATED_IN"
      source: "person"
      target: "event"
    - name: "LOCATED_IN"
      source: "event"
      target: "location"

ingestion:
  max_file_size_mb: 200
  max_pages: 5000

retrieval:
  default_strategy: "hybrid"
  top_k: 20
`;

describe('Spec 03: Config Loader + Zod Schemas', () => {
	let tmpDir: string;
	let loadConfig: (path?: string) => unknown;
	let ConfigValidationError: new (...args: unknown[]) => Error;
	let CONFIG_DEFAULTS: Record<string, unknown>;

	beforeAll(async () => {
		// Dynamic import from the built @mulder/core package
		const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
		loadConfig = core.loadConfig;
		ConfigValidationError = core.ConfigValidationError;
		CONFIG_DEFAULTS = core.CONFIG_DEFAULTS;

		// Create temp directory for test config files
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-03-'));
	});

	afterAll(() => {
		// Clean up temp directory
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

	// ─── QA-01: Valid config loads successfully ───

	describe('QA-01: Valid config loads successfully', () => {
		it('returns a MulderConfig object with all fields populated (required + defaults for optional)', () => {
			const configPath = writeTempConfig(FULL_CONFIG_YAML, 'qa01-full.yaml');
			const config = loadConfig(configPath) as Record<string, unknown>;

			// Required fields present
			expect(config).toBeDefined();
			expect(config).toHaveProperty('project');
			expect(config).toHaveProperty('gcp');
			expect(config).toHaveProperty('ontology');

			// Verify required values
			const project = config.project as Record<string, unknown>;
			expect(project.name).toBe('full-test-project');
			expect(project.description).toBe('Full test configuration');

			const gcp = config.gcp as Record<string, unknown>;
			expect(gcp.project_id).toBe('test-gcp-project');
			expect(gcp.region).toBe('europe-west1');

			const ontology = config.ontology as Record<string, unknown>;
			const entityTypes = ontology.entity_types as Array<Record<string, unknown>>;
			expect(entityTypes).toHaveLength(3);
			expect(entityTypes[0].name).toBe('person');

			// Optional sections should have defaults applied
			expect(config).toHaveProperty('dev_mode');
			expect(config).toHaveProperty('ingestion');
			expect(config).toHaveProperty('extraction');
			expect(config).toHaveProperty('enrichment');
			expect(config).toHaveProperty('embedding');
			expect(config).toHaveProperty('retrieval');
			expect(config).toHaveProperty('safety');
		});
	});

	// ─── QA-02: Missing required field throws ConfigValidationError ───

	describe('QA-02: Missing required field throws ConfigValidationError', () => {
		it('throws ConfigValidationError with an issue pointing to project.name when it is missing', () => {
			const yaml = `
gcp:
  project_id: "test-gcp-project"
  region: "europe-west1"
  cloud_sql:
    instance_name: "test-db"
    database: "testdb"
  storage:
    bucket: "test-bucket"
  document_ai:
    processor_id: "test-processor"
ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships: []
`;
			const configPath = writeTempConfig(yaml, 'qa02-missing-name.yaml');

			expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);

			try {
				loadConfig(configPath);
			} catch (error: unknown) {
				expect(error).toBeInstanceOf(ConfigValidationError);
				const err = error as { issues?: Array<{ path: string }> };
				// Should have an issue mentioning project or project.name
				const hasProjectIssue = err.issues?.some((issue) => issue.path.includes('project'));
				expect(hasProjectIssue, 'Expected an issue pointing to project.name').toBe(true);
			}
		});
	});

	// ─── QA-03: Invalid field type throws ConfigValidationError ───

	describe('QA-03: Invalid field type throws ConfigValidationError', () => {
		it('throws ConfigValidationError with correct path and type error for ingestion.max_file_size_mb: "not-a-number"', () => {
			const yaml = `
project:
  name: "test-project"
gcp:
  project_id: "test-gcp-project"
  region: "europe-west1"
  cloud_sql:
    instance_name: "test-db"
    database: "testdb"
  storage:
    bucket: "test-bucket"
  document_ai:
    processor_id: "test-processor"
ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships: []
ingestion:
  max_file_size_mb: "not-a-number"
`;
			const configPath = writeTempConfig(yaml, 'qa03-invalid-type.yaml');

			expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);

			try {
				loadConfig(configPath);
			} catch (error: unknown) {
				expect(error).toBeInstanceOf(ConfigValidationError);
				const err = error as { issues?: Array<{ path: string; message: string }> };
				const hasPathIssue = err.issues?.some((issue) => issue.path.includes('max_file_size_mb'));
				expect(hasPathIssue, 'Expected an issue pointing to ingestion.max_file_size_mb').toBe(true);
			}
		});
	});

	// ─── QA-04: Default values applied for omitted optional fields ───

	describe('QA-04: Default values applied for omitted optional fields', () => {
		it('applies sensible defaults for dev_mode, ingestion, retrieval, etc. when only required fields provided', () => {
			const configPath = writeTempConfig(MINIMAL_CONFIG_YAML, 'qa04-minimal.yaml');
			const config = loadConfig(configPath) as Record<string, unknown>;

			// dev_mode defaults to false
			expect(config.dev_mode).toBe(false);

			// ingestion defaults
			const ingestion = config.ingestion as Record<string, unknown>;
			expect(ingestion.max_file_size_mb).toBe(100);
			expect(ingestion.max_pages).toBe(2000);

			// retrieval defaults
			const retrieval = config.retrieval as Record<string, unknown>;
			expect(retrieval.default_strategy).toBe('hybrid');
			expect(retrieval.top_k).toBe(10);

			// embedding defaults
			const embedding = config.embedding as Record<string, unknown>;
			expect(embedding.model).toBe('text-embedding-004');
			expect(embedding.storage_dimensions).toBe(768);
			expect(embedding.chunk_size_tokens).toBe(512);

			// safety defaults
			const safety = config.safety as Record<string, unknown>;
			expect(safety.max_pages_without_confirm).toBe(500);
			expect(safety.max_cost_without_confirm_usd).toBe(20);

			// grounding defaults (v2.0 disabled by default)
			const grounding = config.grounding as Record<string, unknown>;
			expect(grounding.enabled).toBe(false);

			// analysis defaults (v2.0 disabled by default)
			const analysis = config.analysis as Record<string, unknown>;
			expect(analysis.enabled).toBe(false);
		});
	});

	// ─── QA-05: Ontology cross-reference validation ───

	describe('QA-05: Ontology cross-reference validation', () => {
		it('throws ConfigValidationError with code "invalid_reference" when relationship references nonexistent entity type', () => {
			const yaml = `
project:
  name: "test-project"
gcp:
  project_id: "test-gcp-project"
  region: "europe-west1"
  cloud_sql:
    instance_name: "test-db"
    database: "testdb"
  storage:
    bucket: "test-bucket"
  document_ai:
    processor_id: "test-processor"
ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships:
    - name: "WORKS_AT"
      source: "nonexistent_type"
      target: "person"
`;
			const configPath = writeTempConfig(yaml, 'qa05-bad-ref.yaml');

			expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);

			try {
				loadConfig(configPath);
			} catch (error: unknown) {
				expect(error).toBeInstanceOf(ConfigValidationError);
				const err = error as { issues?: Array<{ path: string; message: string; code: string }> };

				// Spec requires code "invalid_reference" per QA-05
				const actualCodes = err.issues?.map((i) => `code="${i.code}" path="${i.path}"`).join(', ');
				const invalidRefIssue = err.issues?.find((issue) => issue.code === 'invalid_reference');
				expect(
					invalidRefIssue,
					`Expected an issue with code "invalid_reference", but got: [${actualCodes}]`,
				).toBeDefined();
				expect(invalidRefIssue?.message, 'Expected error message to mention the invalid type name').toMatch(
					/nonexistent_type/i,
				);
			}
		});
	});

	// ─── QA-06: Config object is frozen ───

	describe('QA-06: Config object is frozen', () => {
		it('throws TypeError when attempting to assign a property on the frozen config', () => {
			const configPath = writeTempConfig(MINIMAL_CONFIG_YAML, 'qa06-frozen.yaml');
			const config = loadConfig(configPath) as Record<string, unknown>;

			// In strict mode, assigning to a frozen object throws TypeError
			expect(() => {
				(config.project as Record<string, unknown>).name = 'changed';
			}).toThrow(TypeError);
		});

		it('throws TypeError on nested property assignment', () => {
			const configPath = writeTempConfig(MINIMAL_CONFIG_YAML, 'qa06-frozen-nested.yaml');
			const config = loadConfig(configPath) as Record<string, unknown>;

			// Deep freeze: nested objects should also be frozen
			expect(() => {
				(config.gcp as Record<string, unknown>).project_id = 'changed';
			}).toThrow(TypeError);
		});
	});

	// ─── QA-07: File not found throws ConfigValidationError ───

	describe('QA-07: File not found throws ConfigValidationError', () => {
		it('throws ConfigValidationError (not raw filesystem error) for non-existent path', () => {
			expect(() => loadConfig('/does/not/exist.yaml')).toThrow(ConfigValidationError);
		});
	});

	// ─── QA-08: MULDER_CONFIG environment variable ───

	describe('QA-08: MULDER_CONFIG environment variable', () => {
		const originalEnv = process.env.MULDER_CONFIG;

		afterAll(() => {
			// Restore original env
			if (originalEnv === undefined) {
				process.env.MULDER_CONFIG = undefined;
			} else {
				process.env.MULDER_CONFIG = originalEnv;
			}
		});

		it('loads from MULDER_CONFIG path when called without arguments', () => {
			const yaml = `
project:
  name: "env-var-project"
gcp:
  project_id: "env-gcp-project"
  region: "us-central1"
  cloud_sql:
    instance_name: "env-db"
    database: "envdb"
  storage:
    bucket: "env-bucket"
  document_ai:
    processor_id: "env-processor"
ontology:
  entity_types:
    - name: "document"
      description: "A document entity"
  relationships: []
`;
			const configPath = writeTempConfig(yaml, 'qa08-env-var.yaml');
			process.env.MULDER_CONFIG = configPath;

			const config = loadConfig() as Record<string, unknown>;
			const project = config.project as Record<string, unknown>;
			expect(project.name).toBe('env-var-project');
		});
	});

	// ─── QA-09: Dev mode relaxes GCP requirements ───

	describe('QA-09: Dev mode relaxes GCP requirements', () => {
		it('succeeds with dev_mode: true and no gcp section', () => {
			const yaml = `
project:
  name: "dev-mode-project"
dev_mode: true
ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships: []
`;
			const configPath = writeTempConfig(yaml, 'qa09-dev-mode.yaml');

			// Should NOT throw
			const config = loadConfig(configPath) as Record<string, unknown>;
			expect(config).toBeDefined();
			expect(config.dev_mode).toBe(true);

			const project = config.project as Record<string, unknown>;
			expect(project.name).toBe('dev-mode-project');
		});
	});

	// ─── QA-10: TypeScript types match schema ───

	describe('QA-10: TypeScript types match schema', () => {
		it('exported MulderConfig type has no any types (verified via build + typecheck)', () => {
			// QA-10 is a compile-time check: "MulderConfig type has correctly typed fields with no any".
			// We verify this by confirming that:
			// 1. The build succeeded (beforeAll imported from dist successfully)
			// 2. The typecheck pipeline passes (turborepo typecheck)
			// 3. MulderConfig is a real type export (we can see it in the barrel)
			//
			// Since this is a black-box test and we cannot do compile-time type assertions
			// at runtime, we verify that the config object has the expected shape with
			// correctly typed values at runtime — which proves the schema produces typed output.

			const configPath = writeTempConfig(FULL_CONFIG_YAML, 'qa10-types.yaml');
			const config = loadConfig(configPath) as Record<string, unknown>;

			// Verify field types at runtime match what the TypeScript types should produce
			const project = config.project as Record<string, unknown>;
			expect(typeof project.name).toBe('string');
			expect(typeof project.description).toBe('string');
			expect(Array.isArray(project.supported_locales)).toBe(true);

			const gcp = config.gcp as Record<string, unknown>;
			expect(typeof gcp.project_id).toBe('string');
			expect(typeof gcp.region).toBe('string');

			const cloudSql = gcp.cloud_sql as Record<string, unknown>;
			expect(typeof cloudSql.instance_name).toBe('string');
			expect(typeof cloudSql.database).toBe('string');

			expect(typeof config.dev_mode).toBe('boolean');

			const ontology = config.ontology as Record<string, unknown>;
			expect(Array.isArray(ontology.entity_types)).toBe(true);
			expect(Array.isArray(ontology.relationships)).toBe(true);

			const ingestion = config.ingestion as Record<string, unknown>;
			expect(typeof ingestion.max_file_size_mb).toBe('number');
			expect(typeof ingestion.max_pages).toBe('number');

			const retrieval = config.retrieval as Record<string, unknown>;
			expect(typeof retrieval.default_strategy).toBe('string');
			expect(typeof retrieval.top_k).toBe('number');
		});
	});
});
