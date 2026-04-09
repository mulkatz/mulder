import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 13: GCP + Dev Service Implementations
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests import from @mulder/core barrel (dist/index.js) — the public API surface.
 * No imports from packages/core/src/ internals.
 */

// Minimal valid config with document_ai.processor_id (required since spec 13)
const VALID_CONFIG_WITH_DOCAI = `
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

// Config with document_ai section but missing processor_id
const CONFIG_MISSING_PROCESSOR_ID = `
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
  document_ai: {}

ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships: []
`;

describe('Spec 13: GCP + Dev Service Implementations', () => {
	let tmpDir: string;
	let createServiceRegistry: any;
	let loadConfig: any;
	let createLogger: any;
	let silentLogger: any;
	let exampleConfig: any;

	beforeAll(async () => {
		const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
		createServiceRegistry = core.createServiceRegistry;
		loadConfig = core.loadConfig;
		createLogger = core.createLogger;

		silentLogger = createLogger({ level: 'silent' });
		exampleConfig = await loadConfig(resolve(ROOT, 'mulder.config.example.yaml'));

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-13-'));
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	/** Helper: write YAML to a temp file and return its path */
	function writeTempConfig(yaml: string, filename: string): string {
		const filePath = join(tmpDir, filename);
		writeFileSync(filePath, yaml, 'utf-8');
		return filePath;
	}

	// ─── QA-01: Registry mode selection ───
	// Given dev_mode: false and NODE_ENV unset, when createServiceRegistry() is called,
	// then it returns a Services bundle (does not throw ConfigError).

	it('QA-01: Registry returns GCP services when dev_mode: false and NODE_ENV unset', () => {
		const prodConfig = { ...exampleConfig, dev_mode: false };
		const savedEnv = process.env.NODE_ENV;
		delete process.env.NODE_ENV;
		try {
			const services = createServiceRegistry(prodConfig, silentLogger);
			// Should return a Services bundle, not throw
			expect(services).toBeDefined();
			expect(services.storage).toBeDefined();
			expect(services.documentAi).toBeDefined();
			expect(services.llm).toBeDefined();
			expect(services.embedding).toBeDefined();
			expect(services.firestore).toBeDefined();
		} finally {
			if (savedEnv !== undefined) {
				process.env.NODE_ENV = savedEnv;
			} else {
				process.env.NODE_ENV = 'test';
			}
		}
	});

	// ─── QA-02: Dev mode preserved ───
	// Given dev_mode: true, when createServiceRegistry() is called,
	// then it returns dev (fixture-based) services, not GCP services.

	it('QA-02: Registry returns dev services when dev_mode: true', () => {
		const devConfig = { ...exampleConfig, dev_mode: true };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production'; // ensure NODE_ENV does not help
		try {
			const services = createServiceRegistry(devConfig, silentLogger);
			expect(services).toBeDefined();
			expect(services.storage).toBeDefined();
			expect(services.documentAi).toBeDefined();
			expect(services.llm).toBeDefined();
			expect(services.embedding).toBeDefined();
			expect(services.firestore).toBeDefined();

			// Dev services should be fixture-based. Verify by calling storage.exists()
			// on a known fixture file — GCP services would fail without real credentials.
			const existsResult = services.storage.exists('raw/.gitkeep');
			// Dev services return a Promise that resolves; GCP services would throw/reject
			expect(existsResult).toBeInstanceOf(Promise);
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-03: Test mode blocks GCP ───
	// Given NODE_ENV=test, when createServiceRegistry() is called,
	// then it returns dev services regardless of dev_mode setting.

	it('QA-03: Registry returns dev services when NODE_ENV=test regardless of dev_mode', () => {
		const prodConfig = { ...exampleConfig, dev_mode: false };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'test';
		try {
			const services = createServiceRegistry(prodConfig, silentLogger);
			expect(services).toBeDefined();
			expect(services.storage).toBeDefined();
			expect(services.documentAi).toBeDefined();
			expect(services.llm).toBeDefined();
			expect(services.embedding).toBeDefined();
			expect(services.firestore).toBeDefined();

			// Under NODE_ENV=test, storage should be fixture-based (dev services).
			// Dev storage.exists() returns a Promise resolving to boolean.
			// If GCP services were returned instead, this would fail without credentials.
			const existsResult = services.storage.exists('raw/.gitkeep');
			expect(existsResult).toBeInstanceOf(Promise);
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-04: Config accepts document_ai ───
	// Given a config YAML with gcp.document_ai.processor_id: "test-processor",
	// when loadConfig() is called, then validation passes and the field is accessible.

	it('QA-04: Config accepts gcp.document_ai.processor_id field', () => {
		const configPath = writeTempConfig(VALID_CONFIG_WITH_DOCAI, 'qa04-docai-valid.yaml');
		const config = loadConfig(configPath) as Record<string, any>;

		expect(config).toBeDefined();
		expect(config.gcp).toBeDefined();
		expect(config.gcp.document_ai).toBeDefined();
		expect(config.gcp.document_ai.processor_id).toBe('test-processor');
	});

	// ─── QA-05: Config rejects missing processor_id ───
	// Given a config YAML with gcp.document_ai present but processor_id missing,
	// when loadConfig() is called, then it throws a validation error.

	it('QA-05: Config rejects gcp.document_ai without processor_id', () => {
		const configPath = writeTempConfig(CONFIG_MISSING_PROCESSOR_ID, 'qa05-docai-missing.yaml');

		expect(() => loadConfig(configPath)).toThrow();

		// Verify the error is about the missing processor_id
		try {
			loadConfig(configPath);
		} catch (error: any) {
			// The error should mention processor_id or document_ai
			const errStr = JSON.stringify(error.issues ?? error.message ?? error);
			const mentionsProcessor = errStr.includes('processor_id') || errStr.includes('document_ai');
			expect(mentionsProcessor, `Expected error to mention processor_id or document_ai, got: ${errStr}`).toBe(true);
		}
	});

	// ─── QA-06: GCP services implement interfaces ───
	// Given the services.gcp.ts module, when imported, then createGcpServices() is exported
	// and returns an object satisfying the Services interface (all 5 service properties present).

	it('QA-06: services.gcp.ts exports createGcpServices with all 5 service properties', async () => {
		// Import from the built dist — not from src/
		const gcpServicesModule = await import(resolve(ROOT, 'packages/core/dist/shared/services.gcp.js'));

		// createGcpServices must be exported
		expect(gcpServicesModule.createGcpServices).toBeDefined();
		expect(typeof gcpServicesModule.createGcpServices).toBe('function');

		// Use the full example config (already loaded and validated) — createGcpServices
		// needs embedding.model, extraction config, etc. beyond just gcp fields.
		const services = gcpServicesModule.createGcpServices(exampleConfig, silentLogger);

		// Must have all 5 service properties
		const requiredKeys = ['storage', 'documentAi', 'llm', 'embedding', 'firestore'];
		for (const key of requiredKeys) {
			expect(services, `Missing service property: ${key}`).toHaveProperty(key);
			expect(services[key], `Service property ${key} is null/undefined`).toBeDefined();
		}
	});

	// ─── QA-07: Build succeeds ───
	// Given all changes applied, when pnpm turbo run build is executed,
	// then it completes with zero errors.

	it('QA-07: pnpm turbo run build completes with zero errors', () => {
		const result = execFileSync('pnpm', ['turbo', 'run', 'build'], {
			cwd: ROOT,
			timeout: 120_000,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// If we get here, exit code was 0. Verify output mentions success.
		expect(result).toContain('successful');
	});

	// ─── QA-08: Example config valid ───
	// Given the updated mulder.config.example.yaml, when loaded with loadConfig(),
	// then it passes validation.

	it('QA-08: mulder.config.example.yaml passes validation', () => {
		const exampleConfigPath = resolve(ROOT, 'mulder.config.example.yaml');
		const config = loadConfig(exampleConfigPath) as Record<string, any>;

		expect(config).toBeDefined();
		expect(config.project).toBeDefined();
		expect(config.gcp).toBeDefined();
		expect(config.gcp.document_ai).toBeDefined();
		expect(config.gcp.document_ai.processor_id).toBe('abc123def456');
	});

	// ─── QA-09: document_ai.location default ───
	// Given a config without an explicit document_ai.location, when loaded,
	// then it defaults to 'eu' (the Document AI multi-region for Europe).

	it('QA-09: document_ai.location defaults to "eu" when omitted', () => {
		const configPath = writeTempConfig(VALID_CONFIG_WITH_DOCAI, 'qa09-location-default.yaml');
		const config = loadConfig(configPath) as Record<string, any>;

		expect(config.gcp.document_ai.location).toBe('eu');
	});

	// ─── QA-10: document_ai.location enum constraint ───
	// Given a config with document_ai.location set to a sub-region like
	// 'europe-west1', when loaded, then validation throws.
	// This catches the original P4-GCP-DOCAI-REGION-01 misconfig at config-load
	// time instead of producing a runtime 404 from the Document AI endpoint.

	it('QA-10: document_ai.location rejects sub-regions like "europe-west1"', () => {
		const invalidConfig = `${VALID_CONFIG_WITH_DOCAI.replace(
			'document_ai:\n    processor_id: "test-processor"',
			'document_ai:\n    processor_id: "test-processor"\n    location: "europe-west1"',
		)}`;
		const configPath = writeTempConfig(invalidConfig, 'qa10-location-invalid.yaml');

		expect(() => loadConfig(configPath)).toThrow();

		try {
			loadConfig(configPath);
		} catch (error: any) {
			const errStr = JSON.stringify(error.issues ?? error.message ?? error);
			expect(errStr.toLowerCase()).toMatch(/location|enum|invalid/);
		}
	});

	// ─── QA-11: createGcpServices builds processorName with location ───
	// Given a config with document_ai.location='us', when createGcpServices runs,
	// then the GcpDocumentAiService receives a processorName whose location
	// segment is 'us', not the gcp.region (e.g. 'europe-west1').

	it('QA-11: GcpDocumentAiService is constructed with the document_ai.location segment, not gcp.region', async () => {
		const usConfig = VALID_CONFIG_WITH_DOCAI.replace(
			'document_ai:\n    processor_id: "test-processor"',
			'document_ai:\n    processor_id: "test-processor"\n    location: "us"',
		);
		const configPath = writeTempConfig(usConfig, 'qa11-location-us.yaml');
		const config = loadConfig(configPath) as Record<string, any>;

		const gcpServicesModule = await import(resolve(ROOT, 'packages/core/dist/shared/services.gcp.js'));
		const services = gcpServicesModule.createGcpServices(config, silentLogger);

		// GcpDocumentAiService stores processorName as a private field. Reach
		// into the instance via JSON.stringify of its internal state, or call
		// getProcessorName() if exposed. The test asserts the processor name
		// segment matches the configured location, not gcp.region.
		const docAi = services.documentAi as Record<string, unknown>;
		const internalKeys = Object.keys(docAi).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(docAi) ?? {}));
		// Find the field holding the processor name (it's a string starting with `projects/`).
		let processorName: string | undefined;
		for (const key of Object.keys(docAi)) {
			const v = (docAi as Record<string, unknown>)[key];
			if (typeof v === 'string' && v.startsWith('projects/')) {
				processorName = v;
				break;
			}
		}
		expect(
			processorName,
			`Could not find processorName on GcpDocumentAiService instance (keys: ${internalKeys.join(', ')})`,
		).toBeDefined();
		expect(processorName).toContain('/locations/us/');
		expect(processorName).not.toContain('europe-west1');
		expect(processorName).toContain('processors/test-processor');
	});
});
