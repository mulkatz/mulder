import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, MULDER_TEST_TABLES, truncateExistingTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const pgAvailable = db.isPgAvailable();
let pool: pg.Pool;
let tempDir: string | null = null;
let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		encoding: 'utf-8',
		timeout: 180_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
	});
	if ((result.status ?? 1) !== 0) {
		throw new Error(`Build failed in ${packageDir}:\n${result.stdout}\n${result.stderr}`);
	}
}

function writeMinimalConfigWithoutHarmonization(): string {
	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec114-'));
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec114"',
			'  supported_locales: ["en"]',
			'gcp:',
			'  project_id: "test-project"',
			'  region: "europe-west1"',
			'  cloud_sql:',
			'    instance_name: "mulder-db"',
			'    database: "mulder"',
			'  storage:',
			'    bucket: "mulder-test"',
			'  document_ai:',
			'    processor_id: "processor"',
			'ontology:',
			'  entity_types:',
			'    - name: "case"',
			'      description: "Generic case entity"',
			'  relationships: []',
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function cleanTables(): void {
	truncateExistingTables(MULDER_TEST_TABLES);
}

async function createSourceFixture(label: string): Promise<string> {
	const source = await coreModule.createSource(pool, {
		filename: `${label}-${randomUUID()}.txt`,
		storagePath: `raw/spec114/${label}-${randomUUID()}.txt`,
		fileHash: `spec114-${label}-${randomUUID()}`,
		sourceType: 'text',
	});
	return source.id;
}

function sensitivityMetadata(level: import('@mulder/core').SensitivityLevel) {
	return {
		level,
		reason: 'spec114_fixture',
		assignedBy: 'policy_rule' as const,
		assignedAt: '2026-05-07T00:00:00.000Z',
		piiTypes: [],
		declassifyDate: null,
	};
}

function provenance(sourceDocumentIds: string[] = [randomUUID()]) {
	return {
		sourceDocumentIds,
		extractionPipelineRun: `spec114-run-${randomUUID()}`,
		createdAt: '2026-05-07T00:00:00.000Z',
	};
}

function cloneConfig() {
	return structuredClone(coreModule.loadConfig(EXAMPLE_CONFIG));
}

function invertMappingType(
	type: import('@mulder/core').TaxonomyMappingType,
): import('@mulder/core').TaxonomyMappingType {
	if (type === 'broader') return 'narrower';
	if (type === 'narrower') return 'broader';
	return type;
}

function expectReviewRef(value: unknown, taxonomyId: string, categoryId: string): void {
	expect(value).toEqual(expect.any(Object));
	const ref = value as Record<string, unknown>;
	expect([ref.taxonomy_id, ref.taxonomyId]).toContain(taxonomyId);
	expect([ref.category_id, ref.categoryId]).toContain(categoryId);
}

async function createEntityFixture(label: string, overrides: Partial<import('@mulder/core').CreateEntityInput> = {}) {
	return coreModule.createEntity(pool, {
		name: `Spec 114 ${label} ${randomUUID()}`,
		type: 'case',
		attributes: {},
		sensitivityLevel: 'internal',
		sensitivityMetadata: sensitivityMetadata('internal'),
		...overrides,
	});
}

async function createTaxonomyFixture(
	label: string,
	overrides: Partial<import('@mulder/core').UpsertClassificationTaxonomyInput> = {},
) {
	return coreModule.upsertClassificationTaxonomy(pool, {
		id: `spec114-${label}-${randomUUID()}`,
		name: `Spec 114 ${label} taxonomy`,
		version: '2026',
		language: 'en',
		description: `Classification taxonomy fixture ${label}`,
		status: 'active',
		sourceRef: `config:taxonomy.${label}`,
		provenance: provenance([`source-${label}`]),
		sensitivityLevel: 'internal',
		sensitivityMetadata: sensitivityMetadata('internal'),
		...overrides,
	});
}

async function createCategoryFixture(
	taxonomyId: string,
	label: string,
	overrides: Partial<import('@mulder/core').UpsertClassificationCategoryInput> = {},
) {
	const id = `spec114-${label}-${randomUUID()}`;
	return coreModule.upsertClassificationCategory(pool, {
		id,
		taxonomyId,
		code: label.toUpperCase(),
		label: `Spec 114 ${label}`,
		translations: { de: `DE ${label}`, fr: `FR ${label}` },
		definition: `Definition for ${label}`,
		attributes: { facet: label, ordinal: 1 },
		status: 'active',
		provenance: provenance([`source-${label}`]),
		sensitivityLevel: 'internal',
		sensitivityMetadata: sensitivityMetadata('internal'),
		...overrides,
	});
}

async function createMappingFixture(
	source: import('@mulder/core').ClassificationCategory,
	target: import('@mulder/core').ClassificationCategory,
	overrides: Partial<import('@mulder/core').UpsertTaxonomyMappingInput> = {},
) {
	return coreModule.upsertTaxonomyMapping(pool, {
		source: { taxonomyId: source.taxonomyId, categoryId: source.id },
		target: { taxonomyId: target.taxonomyId, categoryId: target.id },
		mappingType: 'equivalent',
		confidence: 0.84,
		conditions: 'only when fixture context matches',
		rationale: 'The configured categories describe the same class in fixture data.',
		mappingAuthor: 'human',
		reviewStatus: 'reviewed',
		provenance: provenance(),
		sensitivityLevel: 'internal',
		sensitivityMetadata: sensitivityMetadata('internal'),
		...overrides,
	});
}

beforeAll(async () => {
	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);
	coreModule = await import(pathToFileURL(CORE_DIST).href);
	pipelineModule = await import(pathToFileURL(PIPELINE_DIST).href);

	if (!pgAvailable) return;
	ensureSchema();
	pool = new pg.Pool(PG_CONFIG);
});

beforeEach(() => {
	if (!pgAvailable) return;
	cleanTables();
});

afterAll(async () => {
	if (pgAvailable) cleanTables();
	await pool?.end();
	await coreModule?.closeAllPools();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('Spec 114: Classification Harmonization', () => {
	it('QA-01: Config exposes A11 harmonization defaults', () => {
		const minimalConfig = coreModule.loadConfig(writeMinimalConfigWithoutHarmonization()) as Record<string, unknown>;
		const exampleConfig = coreModule.loadConfig(EXAMPLE_CONFIG) as Record<string, unknown>;

		for (const config of [minimalConfig, exampleConfig]) {
			const taxonomy = config.taxonomy as Record<string, unknown>;
			const harmonization = taxonomy.harmonization as Record<string, unknown>;
			expect(harmonization.enabled).toBe(true);
			expect(harmonization.taxonomies).toEqual([]);

			const autoMapping = harmonization.auto_mapping as Record<string, unknown>;
			expect(autoMapping).toMatchObject({
				enabled: false,
				require_human_review: true,
			});
			expect(autoMapping.engine).toEqual(expect.any(String));
			expect(autoMapping.min_confidence_for_auto_link).toBeGreaterThanOrEqual(0);
			expect(autoMapping.min_confidence_for_auto_link).toBeLessThanOrEqual(1);

			const extraction = harmonization.extraction as Record<string, unknown>;
			expect(extraction).toEqual({
				detect_classification_refs: true,
				detect_implicit_classifications: true,
			});
			expect(JSON.stringify(harmonization).toLowerCase()).not.toMatch(/ufo|ufology|sighting|icd|naics/);
		}
	});

	it.skipIf(!pgAvailable)('QA-02: Harmonization schema is constrained', async () => {
		const tableRows = await pool.query<{ table_name: string }>(
			[
				'SELECT table_name',
				'FROM information_schema.tables',
				"WHERE table_schema = 'public'",
				"  AND table_name IN ('classification_taxonomies', 'classification_categories', 'taxonomy_mappings')",
				'ORDER BY table_name;',
			].join('\n'),
		);
		expect(tableRows.rows.map((row) => row.table_name)).toEqual([
			'classification_categories',
			'classification_taxonomies',
			'taxonomy_mappings',
		]);

		const columns = await pool.query<{ table_name: string; column_name: string }>(
			[
				'SELECT table_name, column_name',
				'FROM information_schema.columns',
				"WHERE table_schema = 'public'",
				"  AND table_name IN ('classification_taxonomies', 'classification_categories', 'taxonomy_mappings')",
				'ORDER BY table_name, ordinal_position;',
			].join('\n'),
		);
		const columnsByTable = new Map<string, string[]>();
		for (const row of columns.rows) {
			columnsByTable.set(row.table_name, [...(columnsByTable.get(row.table_name) ?? []), row.column_name]);
		}
		expect(columnsByTable.get('classification_taxonomies')).toEqual([
			'id',
			'name',
			'version',
			'language',
			'description',
			'status',
			'source_ref',
			'provenance',
			'sensitivity_level',
			'sensitivity_metadata',
			'created_at',
			'updated_at',
			'deleted_at',
		]);
		expect(columnsByTable.get('classification_categories')).toEqual([
			'id',
			'taxonomy_id',
			'code',
			'label',
			'translations',
			'definition',
			'parent_id',
			'attributes',
			'status',
			'provenance',
			'sensitivity_level',
			'sensitivity_metadata',
			'created_at',
			'updated_at',
			'deleted_at',
		]);
		expect(columnsByTable.get('taxonomy_mappings')).toEqual([
			'id',
			'source_taxonomy_id',
			'source_category_id',
			'target_taxonomy_id',
			'target_category_id',
			'mapping_type',
			'confidence',
			'conditions',
			'rationale',
			'mapping_author',
			'review_status',
			'provenance',
			'sensitivity_level',
			'sensitivity_metadata',
			'created_at',
			'updated_at',
			'deleted_at',
		]);

		const constraints = await pool.query<{ definition: string }>(
			[
				'SELECT pg_get_constraintdef(oid) AS definition',
				'FROM pg_constraint',
				"WHERE conrelid IN ('classification_taxonomies'::regclass, 'classification_categories'::regclass, 'taxonomy_mappings'::regclass)",
				'ORDER BY conname;',
			].join('\n'),
		);
		const constraintDefs = constraints.rows.map((row) => row.definition).join('\n');
		for (const value of ['equivalent', 'broader', 'narrower', 'overlapping', 'related']) {
			expect(constraintDefs).toContain(value);
		}
		for (const value of ['llm_auto', 'human', 'hybrid', 'draft', 'reviewed', 'contested']) {
			expect(constraintDefs).toContain(value);
		}
		expect(constraintDefs).toContain('confidence >=');
		expect(constraintDefs).toContain('confidence <=');
		expect(constraintDefs).toContain('source_taxonomy_id <> target_taxonomy_id');
		expect(constraintDefs).toContain('FOREIGN KEY (taxonomy_id, parent_id)');
		expect(constraintDefs).toContain('jsonb_typeof(provenance)');
		expect(constraintDefs).toContain('sensitivity_metadata');

		const indexes = await pool.query<{ indexname: string; indexdef: string }>(
			[
				'SELECT indexname, indexdef',
				'FROM pg_indexes',
				"WHERE schemaname = 'public'",
				"  AND tablename IN ('classification_taxonomies', 'classification_categories', 'taxonomy_mappings')",
				'ORDER BY indexname;',
			].join('\n'),
		);
		const indexDefs = indexes.rows.map((row) => `${row.indexname} ${row.indexdef}`).join('\n');
		for (const expectedIndex of [
			'idx_classification_taxonomies_status',
			'idx_classification_categories_active_taxonomy_code',
			'idx_classification_categories_parent',
			'idx_taxonomy_mappings_active_pair_type_conditions',
			'idx_taxonomy_mappings_source_taxonomy',
			'idx_taxonomy_mappings_target_taxonomy',
			'idx_taxonomy_mappings_source_category',
			'idx_taxonomy_mappings_target_category',
			'idx_taxonomy_mappings_mapping_type',
			'idx_taxonomy_mappings_review_status',
			'idx_taxonomy_mappings_sensitivity_level',
		]) {
			expect(indexDefs).toContain(expectedIndex);
		}
		expect(indexDefs).toContain('WHERE (deleted_at IS NULL)');
	});

	it.skipIf(!pgAvailable)('QA-03: Taxonomies and categories round-trip', async () => {
		const taxonomySourceId = randomUUID();
		const parentSourceId = randomUUID();
		const childSourceId = randomUUID();
		const taxonomy = await createTaxonomyFixture('roundtrip', {
			description: 'Round-trip taxonomy with metadata',
			provenance: provenance([taxonomySourceId]),
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		const parent = await createCategoryFixture(taxonomy.id, 'parent', {
			code: 'PARENT',
			label: 'Parent category',
			translations: { de: 'Elternkategorie', es: 'Categoria padre' },
			definition: 'Parent definition',
			attributes: { depth: 0, aliases: ['root'] },
			provenance: provenance([parentSourceId]),
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const child = await createCategoryFixture(taxonomy.id, 'child', {
			code: 'CHILD',
			label: 'Child category',
			parentId: parent.id,
			translations: { de: 'Kindkategorie', es: 'Categoria hija' },
			definition: 'Child definition',
			attributes: { depth: 1, parent: 'PARENT' },
			provenance: provenance([childSourceId]),
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});

		const listedTaxonomies = await coreModule.listClassificationTaxonomies(pool, {
			sourceRef: 'config:taxonomy.roundtrip',
			maxSensitivityLevel: 'restricted',
		});
		expect(listedTaxonomies).toHaveLength(1);
		expect(listedTaxonomies[0]).toMatchObject({
			id: taxonomy.id,
			name: 'Spec 114 roundtrip taxonomy',
			version: '2026',
			language: 'en',
			description: 'Round-trip taxonomy with metadata',
			status: 'active',
			sourceRef: 'config:taxonomy.roundtrip',
			sensitivityLevel: 'restricted',
		});
		expect(listedTaxonomies[0].provenance.sourceDocumentIds).toEqual([taxonomySourceId]);
		expect(listedTaxonomies[0].sensitivityMetadata.level).toBe('restricted');

		const listedCategories = await coreModule.listClassificationCategories(pool, {
			taxonomyId: taxonomy.id,
			maxSensitivityLevel: 'restricted',
		});
		expect(listedCategories.map((category) => category.id).sort()).toEqual([child.id, parent.id].sort());
		const listedParent = listedCategories.find((category) => category.id === parent.id);
		const listedChild = listedCategories.find((category) => category.id === child.id);
		expect(listedParent).toMatchObject({
			taxonomyId: taxonomy.id,
			code: 'PARENT',
			label: 'Parent category',
			parentId: null,
			status: 'active',
			translations: { de: 'Elternkategorie', es: 'Categoria padre' },
			attributes: { depth: 0, aliases: ['root'] },
			sensitivityLevel: 'internal',
		});
		expect(listedParent?.provenance.sourceDocumentIds).toEqual([parentSourceId]);
		expect(listedChild).toMatchObject({
			taxonomyId: taxonomy.id,
			code: 'CHILD',
			label: 'Child category',
			parentId: parent.id,
			status: 'active',
			translations: { de: 'Kindkategorie', es: 'Categoria hija' },
			attributes: { depth: 1, parent: 'PARENT' },
			sensitivityLevel: 'restricted',
		});
		expect(listedChild?.provenance.sourceDocumentIds).toEqual([childSourceId]);
		expect(await coreModule.findClassificationCategory(pool, child.id, { maxSensitivityLevel: 'internal' })).toBeNull();
	});

	it.skipIf(!pgAvailable)('rejects cross-taxonomy category parents', async () => {
		const parentTaxonomy = await createTaxonomyFixture('parent-boundary');
		const childTaxonomy = await createTaxonomyFixture('child-boundary');
		const parent = await createCategoryFixture(parentTaxonomy.id, 'same-taxonomy-parent');
		const sameTaxonomyChild = await createCategoryFixture(parentTaxonomy.id, 'same-taxonomy-child', {
			parentId: parent.id,
		});

		expect(sameTaxonomyChild.parentId).toBe(parent.id);
		await expect(
			createCategoryFixture(childTaxonomy.id, 'cross-taxonomy-child', {
				parentId: parent.id,
			}),
		).rejects.toThrow('Failed to upsert classification category');
	});

	it.skipIf(!pgAvailable)('QA-04: Directed mappings resolve both ways', async () => {
		const sourceTaxonomy = await createTaxonomyFixture('directed-source');
		const targetTaxonomy = await createTaxonomyFixture('directed-target');
		const mappingTypes: import('@mulder/core').TaxonomyMappingType[] = [
			'equivalent',
			'broader',
			'narrower',
			'overlapping',
			'related',
		];

		for (const [index, mappingType] of mappingTypes.entries()) {
			const sourceCategory = await createCategoryFixture(sourceTaxonomy.id, `source-${mappingType}`);
			const targetCategory = await createCategoryFixture(targetTaxonomy.id, `target-${mappingType}`);
			const mapping = await createMappingFixture(sourceCategory, targetCategory, {
				mappingType,
				confidence: 0.7 + index * 0.05,
				conditions: `condition-${mappingType}`,
				rationale: `Rationale for ${mappingType}`,
			});

			const forward = await coreModule.resolveTaxonomyMappings(pool, {
				taxonomyId: sourceTaxonomy.id,
				categoryId: sourceCategory.id,
				targetTaxonomyId: targetTaxonomy.id,
				reviewStatus: 'reviewed',
				maxSensitivityLevel: 'internal',
			});
			const reverse = await coreModule.resolveTaxonomyMappings(pool, {
				taxonomyId: targetTaxonomy.id,
				categoryId: targetCategory.id,
				reviewStatus: 'reviewed',
				maxSensitivityLevel: 'internal',
			});

			expect(forward).toHaveLength(1);
			expect(reverse).toHaveLength(1);
			expect(forward[0]).toMatchObject({
				id: mapping.id,
				direction: 'forward',
				mappingType,
				originalMappingType: mappingType,
				originalSourceTaxonomyId: sourceTaxonomy.id,
				originalSourceCategoryId: sourceCategory.id,
				originalTargetTaxonomyId: targetTaxonomy.id,
				originalTargetCategoryId: targetCategory.id,
				conditions: `condition-${mappingType}`,
				rationale: `Rationale for ${mappingType}`,
			});
			expect(forward[0].confidence).toBeCloseTo(0.7 + index * 0.05, 3);
			expect(reverse[0]).toMatchObject({
				id: mapping.id,
				direction: 'reverse',
				mappingType: invertMappingType(mappingType),
				originalMappingType: mappingType,
				originalSourceTaxonomyId: sourceTaxonomy.id,
				originalSourceCategoryId: sourceCategory.id,
				originalTargetTaxonomyId: targetTaxonomy.id,
				originalTargetCategoryId: targetCategory.id,
				conditions: `condition-${mappingType}`,
				rationale: `Rationale for ${mappingType}`,
			});
			expect(reverse[0].confidence).toBeCloseTo(0.7 + index * 0.05, 3);
		}
	});

	it.skipIf(!pgAvailable)('QA-05: Filtering respects review status and sensitivity', async () => {
		const sourceTaxonomy = await createTaxonomyFixture('filter-source');
		const targetTaxonomy = await createTaxonomyFixture('filter-target');
		const sourceCategory = await createCategoryFixture(sourceTaxonomy.id, 'filter-source-category');
		const targetCategory = await createCategoryFixture(targetTaxonomy.id, 'filter-target-category');
		const draftSourceId = await createSourceFixture('filter-draft');
		const contestedSourceId = await createSourceFixture('filter-contested');
		const draftInternal = await createMappingFixture(sourceCategory, targetCategory, {
			mappingType: 'related',
			conditions: 'draft-internal',
			reviewStatus: 'draft',
			provenance: provenance([draftSourceId]),
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const reviewedRestricted = await createMappingFixture(sourceCategory, targetCategory, {
			mappingType: 'overlapping',
			conditions: 'reviewed-restricted',
			reviewStatus: 'reviewed',
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		await createMappingFixture(sourceCategory, targetCategory, {
			mappingType: 'broader',
			conditions: 'contested-confidential',
			reviewStatus: 'contested',
			provenance: provenance([contestedSourceId]),
			sensitivityLevel: 'confidential',
			sensitivityMetadata: sensitivityMetadata('confidential'),
		});

		const reviewedOnly = await coreModule.resolveTaxonomyMappings(pool, {
			taxonomyId: sourceTaxonomy.id,
			categoryId: sourceCategory.id,
			reviewStatus: 'reviewed',
			maxSensitivityLevel: 'restricted',
		});
		expect(reviewedOnly.map((mapping) => mapping.id)).toEqual([reviewedRestricted.id]);

		const internalOnly = await coreModule.resolveTaxonomyMappings(pool, {
			taxonomyId: sourceTaxonomy.id,
			categoryId: sourceCategory.id,
			reviewStatus: ['draft', 'reviewed', 'contested'],
			maxSensitivityLevel: 'internal',
		});
		expect(internalOnly.map((mapping) => mapping.id)).toEqual([draftInternal.id]);
		expect(
			await coreModule.findTaxonomyMapping(pool, reviewedRestricted.id, { maxSensitivityLevel: 'internal' }),
		).toBeNull();
	});

	it.skipIf(!pgAvailable)('QA-06: Draft mappings become reviewable', async () => {
		const draftSourceId = await createSourceFixture('review-draft');
		const sourceTaxonomy = await createTaxonomyFixture('review-source');
		const targetTaxonomy = await createTaxonomyFixture('review-target');
		const sourceCategory = await createCategoryFixture(sourceTaxonomy.id, 'review-source-category');
		const targetCategory = await createCategoryFixture(targetTaxonomy.id, 'review-target-category');
		const mapping = await createMappingFixture(sourceCategory, targetCategory, {
			mappingType: 'overlapping',
			confidence: 0.66,
			conditions: 'requires reviewer confirmation',
			rationale: 'LLM suggested a partial overlap across configured taxonomies.',
			mappingAuthor: 'llm_auto',
			reviewStatus: 'draft',
			provenance: provenance([draftSourceId]),
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});

		const artifact = await coreModule.findReviewableArtifactBySubject(pool, 'taxonomy_mapping', mapping.id);
		expect(artifact).not.toBeNull();
		expect(artifact).toMatchObject({
			artifactType: 'taxonomy_mapping',
			subjectId: mapping.id,
			subjectTable: 'taxonomy_mappings',
			createdBy: 'llm_auto',
			reviewStatus: 'pending',
		});
		expect(artifact?.currentValue).toMatchObject({
			source: expect.any(Object),
			target: expect.any(Object),
			mapping_type: 'overlapping',
			confidence: 0.66,
			rationale: 'LLM suggested a partial overlap across configured taxonomies.',
		});
		expectReviewRef(artifact?.currentValue.source, sourceTaxonomy.id, sourceCategory.id);
		expectReviewRef(artifact?.currentValue.target, targetTaxonomy.id, targetCategory.id);
		expect(artifact?.currentValue.conditions).toBe('requires reviewer confirmation');
		expect(artifact?.context).toMatchObject({
			sensitivity_level: 'restricted',
			provenance: { source_document_ids: [draftSourceId] },
		});
	});

	it.skipIf(!pgAvailable)('QA-07: Similarity scoring consumes mappings', async () => {
		const sourceTaxonomy = await createTaxonomyFixture('similarity-source');
		const targetTaxonomy = await createTaxonomyFixture('similarity-target');
		const sourceCategory = await createCategoryFixture(sourceTaxonomy.id, 'similarity-source-category');
		const targetCategory = await createCategoryFixture(targetTaxonomy.id, 'similarity-target-category');
		const reviewed = await createMappingFixture(sourceCategory, targetCategory, {
			mappingType: 'equivalent',
			confidence: 0.84,
			conditions: null,
			rationale: 'Reviewed equivalent mapping for similarity scoring.',
			reviewStatus: 'reviewed',
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		await createMappingFixture(sourceCategory, targetCategory, {
			mappingType: 'related',
			confidence: 1,
			conditions: 'restricted alternative',
			rationale: 'Over-sensitive mapping must not leak into internal scoring.',
			reviewStatus: 'reviewed',
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});

		const scored = await pipelineModule.scoreTaxonomyMappingSimilarity(pool, {
			sourceRefs: [{ taxonomyId: sourceTaxonomy.id, categoryId: sourceCategory.id }],
			targetRefs: [{ taxonomyId: targetTaxonomy.id, categoryId: targetCategory.id }],
			reviewStatus: 'reviewed',
			maxSensitivityLevel: 'internal',
		});
		expect(scored.status).toBe('scored');
		expect(scored.score).toBeCloseTo(0.84, 3);
		expect(scored.evidence).toEqual([
			expect.objectContaining({
				mappingId: reviewed.id,
				mappingType: 'equivalent',
				originalMappingType: 'equivalent',
				direction: 'forward',
				confidence: 0.84,
				reviewStatus: 'reviewed',
				conditions: null,
				rationale: 'Reviewed equivalent mapping for similarity scoring.',
				source: { taxonomyId: sourceTaxonomy.id, categoryId: sourceCategory.id },
				target: { taxonomyId: targetTaxonomy.id, categoryId: targetCategory.id },
			}),
		]);

		const excludedByReview = await pipelineModule.scoreTaxonomyMappingSimilarity(pool, {
			sourceRefs: [{ taxonomyId: sourceTaxonomy.id, categoryId: sourceCategory.id }],
			targetRefs: [{ taxonomyId: targetTaxonomy.id, categoryId: targetCategory.id }],
			reviewStatus: 'draft',
			maxSensitivityLevel: 'internal',
		});
		expect(excludedByReview).toMatchObject({
			status: 'insufficient_data',
			score: null,
			evidence: [],
		});
	});

	it.skipIf(!pgAvailable)(
		'keeps restricted taxonomy mapping evidence out of internal persisted similarity reads',
		async () => {
			const sourceTaxonomy = await createTaxonomyFixture('restricted-similarity-source');
			const targetTaxonomy = await createTaxonomyFixture('restricted-similarity-target');
			const sourceCategory = await createCategoryFixture(sourceTaxonomy.id, 'restricted-similarity-source-category');
			const targetCategory = await createCategoryFixture(targetTaxonomy.id, 'restricted-similarity-target-category');
			const restrictedMapping = await createMappingFixture(sourceCategory, targetCategory, {
				mappingType: 'overlapping',
				confidence: 0.9,
				conditions: 'restricted mapping condition',
				rationale: 'Restricted mapping rationale must not be visible to internal readers.',
				reviewStatus: 'reviewed',
				sensitivityLevel: 'restricted',
				sensitivityMetadata: sensitivityMetadata('restricted'),
			});
			const sourceEntity = await createEntityFixture('Restricted Similarity Source Entity', {
				attributes: {
					classification_refs: [{ taxonomyId: sourceTaxonomy.id, categoryId: sourceCategory.id }],
					date: '2020-01-01',
				},
			});
			const targetEntity = await createEntityFixture('Restricted Similarity Target Entity', {
				attributes: {
					classification_refs: [{ taxonomyId: targetTaxonomy.id, categoryId: targetCategory.id }],
					date: '2020-01-01',
				},
			});
			const config = cloneConfig();
			config.review_workflow.enabled = true;
			config.similar_case_discovery.scoring.weights = {
				semantic: 0,
				structural: 0,
				geospatial: 0,
				temporal: 0,
			};
			config.similar_case_discovery.scoring.domain_dimensions = [
				{
					id: 'classification_similarity',
					label: 'Classification similarity',
					source: 'taxonomy_mapping',
					config_ref: 'classification_refs',
					weight: 1,
					metadata: { reviewStatus: 'reviewed' },
				},
			];
			config.similar_case_discovery.auto_discovery.threshold = 0;
			config.similar_case_discovery.auto_discovery.max_auto_links = 1;
			config.similar_case_discovery.auto_discovery.create_graph_edge = true;

			const result = await pipelineModule.discoverSimilarEntities(pool, config, {
				entityId: sourceEntity.id,
				candidateIds: [targetEntity.id],
				maxResults: 1,
				persistResults: true,
				autoDiscover: true,
				maxSensitivityLevel: 'restricted',
				explanation: 'Restricted mapping evidence regression.',
			});

			expect(result.results).toHaveLength(1);
			expect(result.results[0]).toMatchObject({
				entityId: targetEntity.id,
				sensitivityLevel: 'restricted',
				cacheRecord: expect.objectContaining({ sensitivityLevel: 'restricted' }),
				graphEdgeId: expect.any(String),
				reviewArtifactId: expect.any(String),
			});
			expect(result.results[0].domain[0].metadata.evidence).toEqual([
				expect.objectContaining({
					mappingId: restrictedMapping.id,
					rationale: 'Restricted mapping rationale must not be visible to internal readers.',
					sensitivityLevel: 'restricted',
					sensitivityMetadata: expect.objectContaining({ level: 'restricted' }),
				}),
			]);

			await expect(
				coreModule.findSimilarityByPair(pool, sourceEntity.id, targetEntity.id, { maxSensitivityLevel: 'internal' }),
			).resolves.toBeNull();
			await expect(
				coreModule.listSimilarEntities(pool, {
					entityId: sourceEntity.id,
					maxSensitivityLevel: 'internal',
				}),
			).resolves.toEqual([]);
			const restrictedCached = await coreModule.listSimilarEntities(pool, {
				entityId: sourceEntity.id,
				maxSensitivityLevel: 'restricted',
			});
			expect(restrictedCached).toHaveLength(1);
			expect(restrictedCached[0]).toMatchObject({
				entityId: targetEntity.id,
				sensitivityLevel: 'restricted',
			});

			const internalEdges = await coreModule.findEdgesBetweenEntities(pool, sourceEntity.id, targetEntity.id, {
				maxSensitivityLevel: 'internal',
			});
			expect(internalEdges.filter((edge) => edge.relationship === 'SIMILAR_TO')).toEqual([]);
			const restrictedEdges = await coreModule.findEdgesBetweenEntities(pool, sourceEntity.id, targetEntity.id, {
				maxSensitivityLevel: 'restricted',
			});
			expect(restrictedEdges).toEqual([
				expect.objectContaining({
					relationship: 'SIMILAR_TO',
					sensitivityLevel: 'restricted',
					sensitivityMetadata: expect.objectContaining({ level: 'restricted' }),
				}),
			]);

			await expect(
				coreModule.listReviewableArtifacts(pool, {
					artifactType: 'similar_case_link',
					maxSensitivityLevel: 'internal',
				}),
			).resolves.toEqual([]);
			const restrictedArtifacts = await coreModule.listReviewableArtifacts(pool, {
				artifactType: 'similar_case_link',
				maxSensitivityLevel: 'restricted',
			});
			expect(restrictedArtifacts).toEqual([
				expect.objectContaining({
					artifactType: 'similar_case_link',
					context: expect.objectContaining({
						sensitivity_level: 'restricted',
						sensitivity_metadata: expect.objectContaining({ level: 'restricted' }),
					}),
				}),
			]);
		},
	);
});
