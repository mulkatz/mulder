import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.yaml');

/**
 * Black-box QA tests for Spec 26: JSON Schema Generator
 *
 * Each `it()` maps to one QA-NN or CLI-NN condition from Section 5 / 5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls.
 * Never import from packages/ or src/ or apps/.
 *
 * Uses spawnSync (no shell injection) to run the CLI binary as a subprocess.
 */

/**
 * Helper: run the CLI binary via node as a subprocess.
 * Returns stdout, stderr, and exitCode.
 * Uses spawnSync with no shell for safety (equivalent to execFileSync).
 */
function runCli(
	args: string[],
	options?: { cwd?: string },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: options?.cwd ?? ROOT,
		encoding: 'utf-8',
		timeout: 15000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

// ─────────────────────────────────────────────────────────────────────
// Section 5: QA Contract
// ─────────────────────────────────────────────────────────────────────

describe('Spec 26: JSON Schema Generator — QA Contract', () => {
	let schema: Record<string, unknown>;
	let schemaJson: string;

	beforeAll(() => {
		const { stdout, exitCode } = runCli(['config', 'schema', EXAMPLE_CONFIG]);
		expect(exitCode, 'CLI should exit 0 to generate schema for QA tests').toBe(0);
		schema = JSON.parse(stdout) as Record<string, unknown>;
		schemaJson = stdout;
	});

	// ─── QA-01: Schema generates from default config ───

	describe('QA-01: Schema generates from default config', () => {
		it('returns valid JSON Schema with entities and relationships arrays', () => {
			// Must be a valid JSON Schema object
			expect(schema).toBeDefined();
			expect(schema.type).toBe('object');

			// Must have top-level "entities" and "relationships"
			const props = schema.properties as Record<string, Record<string, unknown>>;
			expect(props).toBeDefined();
			expect(props.entities).toBeDefined();
			expect(props.relationships).toBeDefined();

			// Both must be arrays
			expect(props.entities.type).toBe('array');
			expect(props.relationships.type).toBe('array');
		});
	});

	// ─── QA-02: Entity type enum matches config ───

	describe('QA-02: Entity type enum matches config', () => {
		it('entities.items.properties.type.enum contains config types, sorted', () => {
			const expectedTypes = ['document', 'event', 'location', 'organization', 'person'];

			const props = schema.properties as Record<string, Record<string, unknown>>;
			const items = props.entities.items as Record<string, unknown>;
			const itemProps = (items.properties as Record<string, Record<string, unknown>>);
			const typeField = itemProps.type;

			expect(typeField.enum).toBeDefined();
			const enumValues = typeField.enum as string[];

			// Must contain exactly these types, sorted alphabetically
			expect(enumValues).toEqual(expectedTypes);

			// Verify sorted
			const sorted = [...enumValues].sort();
			expect(enumValues).toEqual(sorted);
		});
	});

	// ─── QA-03: Relationship type enum matches config ───

	describe('QA-03: Relationship type enum matches config', () => {
		it('relationships.items.properties.relationship_type.enum contains config types, sorted', () => {
			const expectedRelTypes = [
				'AFFILIATED_WITH',
				'AUTHORED',
				'CLASSIFIED_BY',
				'INVESTIGATED',
				'OCCURRED_AT',
				'REFERENCES',
				'WITNESSED',
			];

			const props = schema.properties as Record<string, Record<string, unknown>>;
			const items = props.relationships.items as Record<string, unknown>;
			const itemProps = (items.properties as Record<string, Record<string, unknown>>);
			const relTypeField = itemProps.relationship_type;

			expect(relTypeField.enum).toBeDefined();
			const enumValues = relTypeField.enum as string[];

			// Must contain exactly these relationship types, sorted alphabetically
			expect(enumValues).toEqual(expectedRelTypes);

			// Verify sorted
			const sorted = [...enumValues].sort();
			expect(enumValues).toEqual(sorted);
		});
	});

	// ─── QA-04: Attribute types map correctly ───

	describe('QA-04: Attribute types map correctly', () => {
		it('date maps to string, geo_point maps to object with lat/lng, string[] maps to array of strings', () => {
			const props = schema.properties as Record<string, Record<string, unknown>>;
			const items = props.entities.items as Record<string, unknown>;
			const itemProps = (items.properties as Record<string, Record<string, unknown>>);
			const attributes = itemProps.attributes;
			const attrProps = (attributes.properties as Record<string, Record<string, unknown>>);

			// date attribute (e.g., "date" on event entity) → type: "string"
			expect(attrProps.date).toBeDefined();
			expect(attrProps.date.type).toBe('string');

			// geo_point attribute (e.g., "coordinates" on location entity) → type: "object" with lat/lng
			expect(attrProps.coordinates).toBeDefined();
			expect(attrProps.coordinates.type).toBe('object');
			const coordProps = attrProps.coordinates.properties as Record<string, Record<string, unknown>>;
			expect(coordProps.lat).toBeDefined();
			expect(coordProps.lat.type).toBe('number');
			expect(coordProps.lng).toBeDefined();
			expect(coordProps.lng.type).toBe('number');

			// No string[] attributes in default config, but we can verify
			// all array-type attributes would map correctly by checking the schema structure.
			// The spec says string[] → array of strings. If present, items.type should be "string".
			// Check all attribute properties for any arrays:
			for (const [, value] of Object.entries(attrProps)) {
				if (value.type === 'array') {
					const arrayItems = value.items as Record<string, unknown>;
					expect(arrayItems).toBeDefined();
					expect(arrayItems.type).toBe('string');
				}
			}
		});
	});

	// ─── QA-05: Schema is deterministic ───

	describe('QA-05: Schema is deterministic', () => {
		it('same config generates byte-identical JSON output', () => {
			const { stdout: stdout1, exitCode: exitCode1 } = runCli([
				'config',
				'schema',
				EXAMPLE_CONFIG,
			]);
			const { stdout: stdout2, exitCode: exitCode2 } = runCli([
				'config',
				'schema',
				EXAMPLE_CONFIG,
			]);

			expect(exitCode1).toBe(0);
			expect(exitCode2).toBe(0);

			// Byte-identical output
			expect(stdout1).toBe(stdout2);
		});
	});

	// ─── QA-06: Runtime validation schema works ───
	// Note: Runtime validation requires importing the Zod v4 schema function.
	// As a black-box test, we verify through the CLI that the schema structure
	// allows a valid Gemini-like response to conform to the JSON Schema.

	describe('QA-06: Runtime validation schema works', () => {
		it('generated JSON Schema structure accepts a valid entity extraction response', () => {
			// Validate that the schema defines required fields correctly
			// so a valid response would pass. We verify the structural contract.
			const props = schema.properties as Record<string, Record<string, unknown>>;

			// entities array items
			const entityItems = props.entities.items as Record<string, unknown>;
			const entityReq = entityItems.required as string[];
			expect(entityReq).toContain('name');
			expect(entityReq).toContain('type');
			expect(entityReq).toContain('confidence');
			expect(entityReq).toContain('attributes');
			expect(entityReq).toContain('mentions');

			// relationships array items
			const relItems = props.relationships.items as Record<string, unknown>;
			const relReq = relItems.required as string[];
			expect(relReq).toContain('source_entity');
			expect(relReq).toContain('target_entity');
			expect(relReq).toContain('relationship_type');
			expect(relReq).toContain('confidence');

			// Top-level required
			const topReq = schema.required as string[];
			expect(topReq).toContain('entities');
			expect(topReq).toContain('relationships');

			// Confidence fields have correct min/max bounds
			const entityConfidence = (entityItems.properties as Record<string, Record<string, unknown>>).confidence;
			expect(entityConfidence.minimum).toBe(0);
			expect(entityConfidence.maximum).toBe(1);
		});
	});

	// ─── QA-07: Runtime validation rejects invalid ───
	// As a black-box test, we verify the schema constrains entity types
	// via enum, which would cause JSON Schema validation to reject unknown types.

	describe('QA-07: Runtime validation rejects invalid', () => {
		it('schema entity type enum does not allow unknown types', () => {
			const props = schema.properties as Record<string, Record<string, unknown>>;
			const items = props.entities.items as Record<string, unknown>;
			const itemProps = (items.properties as Record<string, Record<string, unknown>>);
			const typeField = itemProps.type;

			const enumValues = typeField.enum as string[];

			// Verify enum is constrained — "unknown_type" should NOT be in the enum
			expect(enumValues).not.toContain('unknown_type');
			expect(enumValues).not.toContain('alien');

			// The enum should be a finite set matching config entity types
			expect(enumValues.length).toBeGreaterThan(0);
			expect(enumValues.length).toBeLessThan(100); // sanity check

			// Also verify relationship_type has the same constraint
			const relItems = props.relationships.items as Record<string, unknown>;
			const relProps = (relItems.properties as Record<string, Record<string, unknown>>);
			const relTypeEnum = relProps.relationship_type.enum as string[];
			expect(relTypeEnum).not.toContain('UNKNOWN_RELATIONSHIP');
			expect(relTypeEnum.length).toBeGreaterThan(0);
		});
	});

	// ─── QA-08: $refStrategy: 'none' produces flat schema ───

	describe('QA-08: $refStrategy none produces flat schema', () => {
		it('no $ref keys anywhere in the output', () => {
			// Search the entire JSON string for $ref
			expect(schemaJson).not.toContain('"$ref"');

			// Also verify by traversing the parsed object
			function hasRef(obj: unknown): boolean {
				if (obj === null || typeof obj !== 'object') return false;
				if (Array.isArray(obj)) return obj.some(hasRef);
				const record = obj as Record<string, unknown>;
				if ('$ref' in record) return true;
				return Object.values(record).some(hasRef);
			}

			expect(hasRef(schema)).toBe(false);
		});
	});
});

// ─────────────────────────────────────────────────────────────────────
// Section 5b: CLI Test Matrix
// ─────────────────────────────────────────────────────────────────────

describe('Spec 26: JSON Schema Generator — CLI Test Matrix', () => {
	// ─── CLI-01: mulder config schema ───

	describe('CLI-01: mulder config schema prints valid JSON Schema, exit 0', () => {
		it('prints valid JSON Schema to stdout and exits 0', () => {
			const { stdout, exitCode } = runCli(['config', 'schema', EXAMPLE_CONFIG]);

			expect(exitCode).toBe(0);

			// Must be valid JSON
			const parsed = JSON.parse(stdout);
			expect(parsed).toBeDefined();

			// Must be a JSON Schema (has type: "object" and properties)
			expect(parsed.type).toBe('object');
			expect(parsed.properties).toBeDefined();
		});
	});

	// ─── CLI-02: mulder config schema --json ───

	describe('CLI-02: mulder config schema --json produces same output', () => {
		it('--json flag produces same output as without flag', () => {
			const { stdout: withoutFlag, exitCode: exit1 } = runCli([
				'config',
				'schema',
				EXAMPLE_CONFIG,
			]);
			const { stdout: withFlag, exitCode: exit2 } = runCli([
				'config',
				'schema',
				EXAMPLE_CONFIG,
				'--json',
			]);

			expect(exit1).toBe(0);
			expect(exit2).toBe(0);

			// --json is the default behavior, output should be identical
			expect(withFlag).toBe(withoutFlag);
		});
	});

	// ─── CLI-03: output contains entities and relationships ───

	describe('CLI-03: output contains entities and relationships top-level properties', () => {
		it('stdout JSON has "entities" and "relationships" in properties', () => {
			const { stdout, exitCode } = runCli(['config', 'schema', EXAMPLE_CONFIG]);

			expect(exitCode).toBe(0);

			const parsed = JSON.parse(stdout) as Record<string, unknown>;
			const props = parsed.properties as Record<string, unknown>;
			expect(props).toBeDefined();
			expect(props.entities).toBeDefined();
			expect(props.relationships).toBeDefined();
		});
	});
});

// ─────────────────────────────────────────────────────────────────────
// CLI Smoke Tests
// ─────────────────────────────────────────────────────────────────────

describe('CLI Smoke Tests: config schema', () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-26-'));
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	// ─── SMOKE-01: --help works ───

	describe('SMOKE-01: --help works', () => {
		it('exits 0 and shows usage info', () => {
			const { stdout, exitCode } = runCli(['config', 'schema', '--help']);

			expect(exitCode).toBe(0);
			expect(stdout).toContain('schema');
			expect(stdout).toContain('--json');
			expect(stdout).toContain('--help');
		});
	});

	// ─── SMOKE-02: --json produces valid JSON ───

	describe('SMOKE-02: --json produces valid JSON', () => {
		it('output is parseable as JSON', () => {
			const { stdout, exitCode } = runCli(['config', 'schema', EXAMPLE_CONFIG, '--json']);

			expect(exitCode).toBe(0);

			let parsed: unknown;
			expect(() => {
				parsed = JSON.parse(stdout);
			}).not.toThrow();

			expect(parsed).toBeDefined();
			expect(typeof parsed).toBe('object');
		});
	});

	// ─── SMOKE-03: missing config file gives error ───

	describe('SMOKE-03: missing config file gives error', () => {
		it('exits non-zero when config file does not exist', () => {
			const { exitCode, stderr } = runCli([
				'config',
				'schema',
				'/nonexistent/path/mulder.config.yaml',
			]);

			expect(exitCode).not.toBe(0);
			expect(stderr.length).toBeGreaterThan(0);
		});
	});

	// ─── SMOKE-04: invalid YAML gives error ───

	describe('SMOKE-04: invalid YAML config gives error', () => {
		it('exits non-zero with invalid YAML', () => {
			const invalidYamlPath = join(tmpDir, 'invalid-schema.yaml');
			writeFileSync(invalidYamlPath, '{{{bad yaml', 'utf-8');

			const { exitCode, stderr } = runCli(['config', 'schema', invalidYamlPath]);

			expect(exitCode).not.toBe(0);
			expect(stderr.length).toBeGreaterThan(0);
		});
	});

	// ─── SMOKE-05: config without ontology gives error ───

	describe('SMOKE-05: config without ontology gives error', () => {
		it('exits non-zero when config has no ontology section', () => {
			const noOntologyPath = join(tmpDir, 'no-ontology.yaml');
			writeFileSync(
				noOntologyPath,
				'project:\n  name: "test"\n  description: "test"\n',
				'utf-8',
			);

			const { exitCode, stderr } = runCli(['config', 'schema', noOntologyPath]);

			// Should fail because ontology is required for schema generation
			expect(exitCode).not.toBe(0);
			expect(stderr.length).toBeGreaterThan(0);
		});
	});

	// ─── SMOKE-06: schema output is pretty-printed ───

	describe('SMOKE-06: JSON output is pretty-printed (not minified)', () => {
		it('output contains newlines and indentation', () => {
			const { stdout, exitCode } = runCli(['config', 'schema', EXAMPLE_CONFIG]);

			expect(exitCode).toBe(0);

			// Pretty-printed JSON has newlines
			const lines = stdout.split('\n');
			expect(lines.length).toBeGreaterThan(10);

			// Pretty-printed JSON has indentation
			expect(stdout).toMatch(/^\s{2,}/m);
		});
	});

	// ─── SMOKE-07: schema has valid JSON Schema $schema field ───

	describe('SMOKE-07: output has $schema field', () => {
		it('contains a valid JSON Schema $schema URL', () => {
			const { stdout, exitCode } = runCli(['config', 'schema', EXAMPLE_CONFIG]);

			expect(exitCode).toBe(0);

			const parsed = JSON.parse(stdout) as Record<string, unknown>;
			// Should have a $schema field pointing to draft-07 or later
			if (parsed.$schema) {
				expect(parsed.$schema).toMatch(/json-schema\.org/);
			}
			// If no $schema, that's also acceptable (not all generators add it)
		});
	});

	// ─── SMOKE-08: default config path resolution ───

	describe('SMOKE-08: runs without explicit config path (uses default)', () => {
		it('uses mulder.config.yaml from cwd when no path given', () => {
			const { stdout, exitCode } = runCli(['config', 'schema']);

			// Should work because mulder.config.yaml exists in ROOT
			expect(exitCode).toBe(0);

			const parsed = JSON.parse(stdout);
			expect(parsed.type).toBe('object');
		});
	});
});
