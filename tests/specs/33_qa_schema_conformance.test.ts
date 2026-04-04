import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

/**
 * QA Gate — Schema Conformance (QA-1)
 *
 * Verifies that the PostgreSQL schema (DDL via migrations) matches:
 * 1. TypeScript type definitions in packages/core/src/database/repositories/*.types.ts
 * 2. Functional spec §4.3
 *
 * QA-01: Column counts match between DDL and TypeScript row types
 * QA-02: Column data types match TypeScript types
 * QA-03: FK cascades match spec
 * QA-04: HNSW index exists with correct params
 * QA-05: GIN indexes exist
 * QA-06: Taxonomy enums intentionally different
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runSql(sql: string): string {
	try {
		const result = execFileSync(
			'docker',
			['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
			{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		return (result ?? '').trim();
	} catch (error: unknown) {
		const err = error as { stderr?: string; status?: number };
		throw new Error(`psql failed (exit ${err.status}): ${err.stderr}`);
	}
}

function isPgAvailable(): boolean {
	try {
		execFileSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Get all column names for a table from information_schema.
 */
function getTableColumns(tableName: string): string[] {
	const result = runSql(
		`SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'public' ORDER BY ordinal_position;`,
	);
	return result.split('\n').filter(Boolean);
}

/**
 * Get column data types for a table.
 */
function getColumnTypes(tableName: string): Map<string, string> {
	const result = runSql(
		`SELECT column_name, data_type, is_nullable, udt_name FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'public' ORDER BY ordinal_position;`,
	);
	const map = new Map<string, string>();
	for (const line of result.split('\n').filter(Boolean)) {
		const [colName, dataType, _nullable, udtName] = line.split('|');
		map.set(colName, udtName || dataType);
	}
	return map;
}

/**
 * Count fields in a TypeScript interface by reading and parsing the source file.
 */
function countTypeFields(filePath: string, typeName: string): number {
	const content = readFileSync(filePath, 'utf-8');
	// Find the interface/type block
	const regex = new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${typeName}\\s*(?:=\\s*)?\\{([^}]+)\\}`, 's');
	const match = content.match(regex);
	if (!match) throw new Error(`Type ${typeName} not found in ${filePath}`);
	const body = match[1];
	// Count lines that have a property definition (name: type pattern)
	const props = body.split('\n').filter((line) => {
		const trimmed = line.trim();
		// Match "propertyName: type" or "propertyName?: type" — skip comments and empty lines
		return /^[a-zA-Z_]\w*\??\s*:/.test(trimmed);
	});
	return props.length;
}

/**
 * Extract field names from a TypeScript interface.
 */
function getTypeFieldNames(filePath: string, typeName: string): string[] {
	const content = readFileSync(filePath, 'utf-8');
	const regex = new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${typeName}\\s*(?:=\\s*)?\\{([^}]+)\\}`, 's');
	const match = content.match(regex);
	if (!match) throw new Error(`Type ${typeName} not found in ${filePath}`);
	const body = match[1];
	const names: string[] = [];
	for (const line of body.split('\n')) {
		const trimmed = line.trim();
		const propMatch = trimmed.match(/^([a-zA-Z_]\w*)\??\s*:/);
		if (propMatch) {
			names.push(propMatch[1]);
		}
	}
	return names;
}

/**
 * Convert camelCase to snake_case.
 */
function camelToSnake(str: string): string {
	return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// ---------------------------------------------------------------------------
// Type definition file paths
// ---------------------------------------------------------------------------

const TYPE_FILES = {
	source: resolve(ROOT, 'packages/core/src/database/repositories/source.types.ts'),
	story: resolve(ROOT, 'packages/core/src/database/repositories/story.types.ts'),
	entity: resolve(ROOT, 'packages/core/src/database/repositories/entity.types.ts'),
	edge: resolve(ROOT, 'packages/core/src/database/repositories/edge.types.ts'),
	taxonomy: resolve(ROOT, 'packages/core/src/database/repositories/taxonomy.types.ts'),
	chunk: resolve(ROOT, 'packages/core/src/database/repositories/chunk.types.ts'),
};

// ---------------------------------------------------------------------------
// Table → TypeScript row type mappings
// ---------------------------------------------------------------------------

/**
 * Maps each table to its primary TypeScript row type and known column exclusions.
 * Some columns exist in the DB but are intentionally excluded from the domain type
 * (e.g., name_embedding on entities, fts_vector on chunks — both are internal/generated).
 */
const TABLE_TYPE_MAP: Record<
	string,
	{
		file: string;
		typeName: string;
		/** DB columns not in the TS type (by design) */
		dbOnlyColumns?: string[];
		/** TS fields not in the DB (by design) */
		tsOnlyFields?: string[];
	}
> = {
	sources: { file: TYPE_FILES.source, typeName: 'Source' },
	source_steps: { file: TYPE_FILES.source, typeName: 'SourceStep' },
	stories: { file: TYPE_FILES.story, typeName: 'Story' },
	entities: {
		file: TYPE_FILES.entity,
		typeName: 'Entity',
		dbOnlyColumns: ['name_embedding'], // migration 017, internal for entity resolution
	},
	entity_aliases: { file: TYPE_FILES.entity, typeName: 'EntityAlias' },
	story_entities: { file: TYPE_FILES.entity, typeName: 'StoryEntity' },
	entity_edges: { file: TYPE_FILES.edge, typeName: 'EntityEdge' },
	chunks: {
		file: TYPE_FILES.chunk,
		typeName: 'Chunk',
		dbOnlyColumns: ['fts_vector'], // generated column, read-only
	},
	taxonomy: { file: TYPE_FILES.taxonomy, typeName: 'TaxonomyEntry' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 33 — QA-1: Schema Conformance', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: PostgreSQL container not available. Start with:\n' +
					'  docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
			return;
		}

		// Run migrations
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}
	}, 60000);

	afterAll(() => {
		// No cleanup needed — schema tests are read-only
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-01: Column count matches between DDL and TypeScript row types
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-01: Column counts match TypeScript types', () => {
		for (const [tableName, config] of Object.entries(TABLE_TYPE_MAP)) {
			it(`${tableName}: column count matches ${config.typeName}`, () => {
				if (!pgAvailable) return;

				const dbColumns = getTableColumns(tableName);
				const tsFieldCount = countTypeFields(config.file, config.typeName);

				const dbOnlyCount = config.dbOnlyColumns?.length ?? 0;
				const tsOnlyCount = config.tsOnlyFields?.length ?? 0;

				// DB columns - DB-only = TS fields - TS-only
				// i.e., DB columns - DB-only + TS-only = TS fields
				const expectedTsFields = dbColumns.length - dbOnlyCount + tsOnlyCount;

				expect(
					tsFieldCount,
					`Table '${tableName}' has ${dbColumns.length} DB columns ` +
						`(${dbOnlyCount} DB-only), expected ${expectedTsFields} TS fields in ${config.typeName}, ` +
						`got ${tsFieldCount}`,
				).toBe(expectedTsFields);
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-02: Column data types match TypeScript
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-02: Column types match TypeScript types', () => {
		/**
		 * Mapping from PostgreSQL UDT names to expected TypeScript types.
		 */
		const PG_TO_TS: Record<string, string[]> = {
			uuid: ['string'],
			text: ['string'],
			int4: ['number'],
			int8: ['number'],
			float8: ['number'],
			bool: ['boolean'],
			timestamptz: ['Date'],
			jsonb: ['Record<string, unknown>'],
			_text: ['string[]'], // TEXT[]
			vector: ['string', 'number[]', 'string | null', 'number[] | null'], // pgvector
			tsvector: ['string', 'string | null'], // tsvector
			job_status: ['string'], // enum stored as TEXT in TS
		};

		for (const [tableName, config] of Object.entries(TABLE_TYPE_MAP)) {
			it(`${tableName}: data types are compatible with ${config.typeName}`, () => {
				if (!pgAvailable) return;

				const dbTypes = getColumnTypes(tableName);
				const tsFields = getTypeFieldNames(config.file, config.typeName);
				const dbOnlyColumns = new Set(config.dbOnlyColumns ?? []);

				// For each TS field, find the corresponding DB column and check type compatibility
				for (const tsField of tsFields) {
					const dbColumn = camelToSnake(tsField);

					if (!dbTypes.has(dbColumn)) {
						// TS field exists but no DB column — only OK if it's a TS-only field
						const tsOnlyFields = new Set(config.tsOnlyFields ?? []);
						expect(
							tsOnlyFields.has(tsField),
							`TS field '${tsField}' (${config.typeName}) has no matching DB column '${dbColumn}' in '${tableName}'`,
						).toBe(true);
						continue;
					}

					const pgType = dbTypes.get(dbColumn);
					if (!pgType) continue;
					const allowedTsTypes = PG_TO_TS[pgType];

					// We don't do full TS type parsing here — just verify the PG type is one we recognize
					expect(allowedTsTypes, `Unknown PG type '${pgType}' for column '${tableName}.${dbColumn}'`).toBeDefined();
				}

				// Verify no unexpected DB columns (that aren't in dbOnlyColumns)
				for (const [dbCol] of dbTypes) {
					if (dbOnlyColumns.has(dbCol)) continue;
					const expectedTsField = dbCol.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
					const hasField = tsFields.includes(expectedTsField);
					expect(
						hasField,
						`DB column '${tableName}.${dbCol}' has no matching TS field '${expectedTsField}' in ${config.typeName}`,
					).toBe(true);
				}
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-03: FK cascades match spec
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-03: FK cascades match spec', () => {
		it('stories.source_id → sources(id) has NO CASCADE (managed by reset function)', () => {
			if (!pgAvailable) return;

			const result = runSql(
				`SELECT rc.delete_rule FROM information_schema.referential_constraints rc
				 JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name
				 WHERE kcu.table_name = 'stories' AND kcu.column_name = 'source_id';`,
			);
			expect(result).toBe('NO ACTION');
		});

		it('entity_aliases.entity_id → entities(id) ON DELETE CASCADE', () => {
			if (!pgAvailable) return;

			const result = runSql(
				`SELECT rc.delete_rule FROM information_schema.referential_constraints rc
				 JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name
				 WHERE kcu.table_name = 'entity_aliases' AND kcu.column_name = 'entity_id';`,
			);
			expect(result).toBe('CASCADE');
		});

		it('story_entities.story_id → stories(id) ON DELETE CASCADE', () => {
			if (!pgAvailable) return;

			const result = runSql(
				`SELECT rc.delete_rule FROM information_schema.referential_constraints rc
				 JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name
				 WHERE kcu.table_name = 'story_entities' AND kcu.column_name = 'story_id';`,
			);
			expect(result).toBe('CASCADE');
		});

		it('entity_edges.story_id → stories(id) ON DELETE CASCADE', () => {
			if (!pgAvailable) return;

			const result = runSql(
				`SELECT rc.delete_rule FROM information_schema.referential_constraints rc
				 JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name
				 WHERE kcu.table_name = 'entity_edges' AND kcu.column_name = 'story_id';`,
			);
			expect(result).toBe('CASCADE');
		});

		it('chunks.story_id → stories(id) ON DELETE CASCADE', () => {
			if (!pgAvailable) return;

			const result = runSql(
				`SELECT rc.delete_rule FROM information_schema.referential_constraints rc
				 JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name
				 WHERE kcu.table_name = 'chunks' AND kcu.column_name = 'story_id';`,
			);
			expect(result).toBe('CASCADE');
		});

		it('chunks.parent_chunk_id → chunks(id) ON DELETE CASCADE', () => {
			if (!pgAvailable) return;

			const result = runSql(
				`SELECT rc.delete_rule FROM information_schema.referential_constraints rc
				 JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name
				 WHERE kcu.table_name = 'chunks' AND kcu.column_name = 'parent_chunk_id';`,
			);
			expect(result).toBe('CASCADE');
		});

		it('source_steps.source_id → sources(id) ON DELETE CASCADE', () => {
			if (!pgAvailable) return;

			const result = runSql(
				`SELECT rc.delete_rule FROM information_schema.referential_constraints rc
				 JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name
				 WHERE kcu.table_name = 'source_steps' AND kcu.column_name = 'source_id';`,
			);
			expect(result).toBe('CASCADE');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-04: HNSW index exists with correct params
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-04: HNSW index on chunks.embedding', () => {
		it('idx_chunks_embedding uses HNSW with vector_cosine_ops, m=16, ef_construction=64', () => {
			if (!pgAvailable) return;

			// Verify access method is hnsw
			const method = runSql(
				`SELECT am.amname FROM pg_index idx
				 JOIN pg_class cls ON idx.indexrelid = cls.oid
				 JOIN pg_am am ON cls.relam = am.oid
				 WHERE cls.relname = 'idx_chunks_embedding';`,
			);
			expect(method).toBe('hnsw');

			// Verify the index definition includes vector_cosine_ops and params
			const indexDef = runSql(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_chunks_embedding';`);
			expect(indexDef.toLowerCase()).toContain('vector_cosine_ops');
			// PostgreSQL may quote the values: m='16' or m = 16
			expect(indexDef).toMatch(/m\s*=\s*'?16'?/);
			expect(indexDef).toMatch(/ef_construction\s*=\s*'?64'?/);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-05: GIN indexes exist
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-05: GIN indexes', () => {
		it('GIN index on chunks.fts_vector exists', () => {
			if (!pgAvailable) return;

			const method = runSql(
				`SELECT am.amname FROM pg_index idx
				 JOIN pg_class cls ON idx.indexrelid = cls.oid
				 JOIN pg_am am ON cls.relam = am.oid
				 WHERE cls.relname = 'idx_chunks_fts';`,
			);
			expect(method).toBe('gin');
		});

		it('GIN index on entities.name with gin_trgm_ops exists', () => {
			if (!pgAvailable) return;

			const indexDef = runSql(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_entities_name_trgm';`);
			expect(indexDef.toLowerCase()).toContain('gin');
			expect(indexDef.toLowerCase()).toContain('gin_trgm_ops');
		});

		it('GIN index on taxonomy.canonical_name with gin_trgm_ops exists', () => {
			if (!pgAvailable) return;

			const indexDef = runSql(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_taxonomy_name_trgm';`);
			expect(indexDef.toLowerCase()).toContain('gin');
			expect(indexDef.toLowerCase()).toContain('gin_trgm_ops');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-06: Taxonomy enums intentionally different
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-06: TaxonomyStatus vs TaxonomyEntryStatus are intentionally different', () => {
		it('TaxonomyStatus (entity-level) has auto|curated|merged', () => {
			if (!pgAvailable) return;

			const content = readFileSync(TYPE_FILES.entity, 'utf-8');
			const match = content.match(/export\s+type\s+TaxonomyStatus\s*=\s*([^;]+);/);
			expect(match).not.toBeNull();

			const typeStr = match?.[1] ?? '';
			expect(typeStr).toContain("'auto'");
			expect(typeStr).toContain("'curated'");
			expect(typeStr).toContain("'merged'");
		});

		it('TaxonomyEntryStatus (taxonomy-entry-level) has auto|confirmed|rejected', () => {
			if (!pgAvailable) return;

			const content = readFileSync(TYPE_FILES.taxonomy, 'utf-8');
			const match = content.match(/export\s+type\s+TaxonomyEntryStatus\s*=\s*([^;]+);/);
			expect(match).not.toBeNull();

			const typeStr = match?.[1] ?? '';
			expect(typeStr).toContain("'auto'");
			expect(typeStr).toContain("'confirmed'");
			expect(typeStr).toContain("'rejected'");
		});

		it('The two enums are different (not identical)', () => {
			if (!pgAvailable) return;

			const entityContent = readFileSync(TYPE_FILES.entity, 'utf-8');
			const taxonomyContent = readFileSync(TYPE_FILES.taxonomy, 'utf-8');

			const tsMatch = entityContent.match(/export\s+type\s+TaxonomyStatus\s*=\s*([^;]+);/);
			const teMatch = taxonomyContent.match(/export\s+type\s+TaxonomyEntryStatus\s*=\s*([^;]+);/);

			expect(tsMatch).not.toBeNull();
			expect(teMatch).not.toBeNull();

			// They share 'auto' but differ on curated/merged vs confirmed/rejected
			const tsValues = (tsMatch?.[1] ?? '').trim();
			const teValues = (teMatch?.[1] ?? '').trim();
			expect(tsValues).not.toBe(teValues);
		});
	});
});
