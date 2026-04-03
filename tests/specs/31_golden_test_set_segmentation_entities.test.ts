import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SEGMENTATION_GOLDEN_DIR = resolve(ROOT, 'eval/golden/segmentation');
const ENTITY_GOLDEN_DIR = resolve(ROOT, 'eval/golden/entities');
const SEGMENTS_FIXTURE_DIR = resolve(ROOT, 'fixtures/segments');
const ENTITIES_FIXTURE_DIR = resolve(ROOT, 'fixtures/entities');
const BASELINE_PATH = resolve(ROOT, 'eval/metrics/baseline.json');
const EVAL_DIST = resolve(ROOT, 'packages/eval/dist/index.js');

/**
 * Black-box QA tests for Spec 31: Golden Test Set — Segmentation + Entities
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: filesystem inspection,
 * subprocess calls against the built eval package dist, and public API imports.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a JS expression in a subprocess that imports the eval package dist.
 * Returns the JSON-parsed stdout. This is the black-box boundary for
 * testing the eval package's public API without importing internal modules.
 */
function evalExpr(expression: string): unknown {
	const script = `
		import * as evalPkg from ${JSON.stringify(`file://${EVAL_DIST}`)};
		const result = ${expression};
		process.stdout.write(JSON.stringify(result));
	`;
	const result = execFileSync('node', ['--input-type=module', '-e', script], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 30000,
		env: { ...process.env, NODE_ENV: 'test' },
	});
	return JSON.parse(result);
}

/**
 * Execute an async JS expression in a subprocess that imports the eval package dist.
 * Returns the JSON-parsed stdout.
 */
function evalExprAsync(expression: string): unknown {
	const script = `
		import * as evalPkg from ${JSON.stringify(`file://${EVAL_DIST}`)};
		const result = await (async () => { return ${expression}; })();
		process.stdout.write(JSON.stringify(result));
	`;
	const result = execFileSync('node', ['--input-type=module', '-e', script], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 30000,
		env: { ...process.env, NODE_ENV: 'test' },
	});
	return JSON.parse(result);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Spec 31 — Golden Test Set: Segmentation + Entities', () => {
	// ─── QA-01: Segmentation golden directory exists with >= 3 JSON files ───

	it('QA-01: eval/golden/segmentation/ exists with >= 3 JSON files', () => {
		expect(existsSync(SEGMENTATION_GOLDEN_DIR)).toBe(true);

		const files = readdirSync(SEGMENTATION_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(files.length).toBeGreaterThanOrEqual(3);
	});

	// ─── QA-02: Segmentation golden files contain all required fields ───

	it('QA-02: every segmentation golden JSON file has required fields: sourceSlug, totalPages, difficulty, expectedSegmentCount, expectedSegments, annotation', () => {
		const files = readdirSync(SEGMENTATION_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(SEGMENTATION_GOLDEN_DIR, file), 'utf-8'));

			expect(content, `${file}: missing sourceSlug`).toHaveProperty('sourceSlug');
			expect(typeof content.sourceSlug, `${file}: sourceSlug not string`).toBe('string');
			expect(content.sourceSlug.length, `${file}: sourceSlug empty`).toBeGreaterThan(0);

			expect(content, `${file}: missing totalPages`).toHaveProperty('totalPages');
			expect(typeof content.totalPages, `${file}: totalPages not number`).toBe('number');
			expect(content.totalPages, `${file}: totalPages < 1`).toBeGreaterThanOrEqual(1);

			expect(content, `${file}: missing difficulty`).toHaveProperty('difficulty');
			expect(['simple', 'moderate', 'complex'], `${file}: invalid difficulty "${content.difficulty}"`).toContain(
				content.difficulty,
			);

			expect(content, `${file}: missing expectedSegmentCount`).toHaveProperty('expectedSegmentCount');
			expect(typeof content.expectedSegmentCount, `${file}: expectedSegmentCount not number`).toBe('number');
			expect(content.expectedSegmentCount, `${file}: expectedSegmentCount < 1`).toBeGreaterThanOrEqual(1);

			expect(content, `${file}: missing expectedSegments`).toHaveProperty('expectedSegments');
			expect(Array.isArray(content.expectedSegments), `${file}: expectedSegments not array`).toBe(true);
			expect(
				content.expectedSegments.length,
				`${file}: expectedSegments count mismatch with expectedSegmentCount`,
			).toBe(content.expectedSegmentCount);

			// Each expected segment must have title, pageStart, pageEnd, category
			for (const seg of content.expectedSegments) {
				expect(seg).toHaveProperty('title');
				expect(seg).toHaveProperty('pageStart');
				expect(seg).toHaveProperty('pageEnd');
				expect(seg).toHaveProperty('category');
			}

			expect(content, `${file}: missing annotation`).toHaveProperty('annotation');
			expect(typeof content.annotation, `${file}: annotation not object`).toBe('object');
			expect(content.annotation, `${file}: annotation missing author`).toHaveProperty('author');
			expect(content.annotation, `${file}: annotation missing date`).toHaveProperty('date');
		}
	});

	// ─── QA-03: Segment fixtures exist for every golden document ───

	it('QA-03: every segmentation golden document has >= 1 .meta.json fixture in fixtures/segments/{slug}/', () => {
		const files = readdirSync(SEGMENTATION_GOLDEN_DIR).filter((f) => f.endsWith('.json'));

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(SEGMENTATION_GOLDEN_DIR, file), 'utf-8'));
			const slug = content.sourceSlug;

			const slugDir = join(SEGMENTS_FIXTURE_DIR, slug);
			expect(existsSync(slugDir), `Missing fixture directory for slug="${slug}" at ${slugDir}`).toBe(true);

			const metaFiles = readdirSync(slugDir).filter((f) => f.endsWith('.meta.json'));
			expect(metaFiles.length, `No .meta.json fixtures found in ${slugDir}`).toBeGreaterThanOrEqual(1);
		}
	});

	// ─── QA-04: Entity golden directory exists with >= 5 JSON files ───

	it('QA-04: eval/golden/entities/ exists with >= 5 JSON files', () => {
		expect(existsSync(ENTITY_GOLDEN_DIR)).toBe(true);

		const files = readdirSync(ENTITY_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(files.length).toBeGreaterThanOrEqual(5);
	});

	// ─── QA-05: Entity golden files contain all required fields ───

	it('QA-05: every entity golden JSON file has required fields: segmentId, sourceSlug, difficulty, languages, expectedEntities, expectedRelationships, annotation', () => {
		const files = readdirSync(ENTITY_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(ENTITY_GOLDEN_DIR, file), 'utf-8'));

			expect(content, `${file}: missing segmentId`).toHaveProperty('segmentId');
			expect(typeof content.segmentId, `${file}: segmentId not string`).toBe('string');
			expect(content.segmentId.length, `${file}: segmentId empty`).toBeGreaterThan(0);

			expect(content, `${file}: missing sourceSlug`).toHaveProperty('sourceSlug');
			expect(typeof content.sourceSlug, `${file}: sourceSlug not string`).toBe('string');

			expect(content, `${file}: missing difficulty`).toHaveProperty('difficulty');
			expect(['simple', 'moderate', 'complex'], `${file}: invalid difficulty "${content.difficulty}"`).toContain(
				content.difficulty,
			);

			expect(content, `${file}: missing languages`).toHaveProperty('languages');
			expect(Array.isArray(content.languages), `${file}: languages not array`).toBe(true);
			expect(content.languages.length, `${file}: languages empty`).toBeGreaterThan(0);

			expect(content, `${file}: missing expectedEntities`).toHaveProperty('expectedEntities');
			expect(Array.isArray(content.expectedEntities), `${file}: expectedEntities not array`).toBe(true);

			expect(content, `${file}: missing expectedRelationships`).toHaveProperty('expectedRelationships');
			expect(Array.isArray(content.expectedRelationships), `${file}: expectedRelationships not array`).toBe(true);

			// Each expected entity must have name and type
			for (const entity of content.expectedEntities) {
				expect(entity, `${file}: entity missing name`).toHaveProperty('name');
				expect(entity, `${file}: entity missing type`).toHaveProperty('type');
			}

			// Each expected relationship must have sourceEntity, targetEntity, relationshipType
			for (const rel of content.expectedRelationships) {
				expect(rel, `${file}: relationship missing sourceEntity`).toHaveProperty('sourceEntity');
				expect(rel, `${file}: relationship missing targetEntity`).toHaveProperty('targetEntity');
				expect(rel, `${file}: relationship missing relationshipType`).toHaveProperty('relationshipType');
			}

			expect(content, `${file}: missing annotation`).toHaveProperty('annotation');
			expect(typeof content.annotation, `${file}: annotation not object`).toBe('object');
			expect(content.annotation, `${file}: annotation missing author`).toHaveProperty('author');
			expect(content.annotation, `${file}: annotation missing date`).toHaveProperty('date');
		}
	});

	// ─── QA-06: Entity fixtures exist for every golden segment ───

	it('QA-06: every entity golden segment has a matching {segmentId}.entities.json fixture', () => {
		const files = readdirSync(ENTITY_GOLDEN_DIR).filter((f) => f.endsWith('.json'));

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(ENTITY_GOLDEN_DIR, file), 'utf-8'));
			const segmentId = content.segmentId;

			const fixtureFile = join(ENTITIES_FIXTURE_DIR, `${segmentId}.entities.json`);
			expect(
				existsSync(fixtureFile),
				`Missing entity fixture for segmentId="${segmentId}" (expected at ${fixtureFile})`,
			).toBe(true);

			// Verify the fixture is valid JSON with entities and relationships arrays
			const fixture = JSON.parse(readFileSync(fixtureFile, 'utf-8'));
			expect(fixture, `${fixtureFile}: missing entities`).toHaveProperty('entities');
			expect(Array.isArray(fixture.entities), `${fixtureFile}: entities not array`).toBe(true);
			expect(fixture, `${fixtureFile}: missing relationships`).toHaveProperty('relationships');
			expect(Array.isArray(fixture.relationships), `${fixtureFile}: relationships not array`).toBe(true);
		}
	});

	// ─── QA-07: Boundary accuracy correct for exact match ───

	it('QA-07: computeBoundaryAccuracy returns 1.0 for identical segment boundaries', () => {
		const expected = JSON.stringify([
			{ title: 'Story A', pageStart: 1, pageEnd: 4, category: 'report' },
			{ title: 'Story B', pageStart: 5, pageEnd: 9, category: 'editorial' },
		]);
		const actual = JSON.stringify([
			{ title: 'Story A', pageStart: 1, pageEnd: 4, category: 'report' },
			{ title: 'Story B', pageStart: 5, pageEnd: 9, category: 'editorial' },
		]);

		const result = evalExpr(`evalPkg.computeBoundaryAccuracy(${expected}, ${actual})`) as number;

		expect(result).toBe(1.0);
	});

	// ─── QA-08: Boundary accuracy correct for partial mismatch ───

	it('QA-08: computeBoundaryAccuracy returns value between 0.0 and 1.0 (exclusive) for partial mismatch', () => {
		const expected = JSON.stringify([
			{ title: 'Story A', pageStart: 1, pageEnd: 4, category: 'report' },
			{ title: 'Story B', pageStart: 5, pageEnd: 9, category: 'editorial' },
		]);
		// Off-by-one on Story A's pageEnd, exact on Story B
		const actual = JSON.stringify([
			{ title: 'Story A', pageStart: 1, pageEnd: 5, category: 'report' },
			{ title: 'Story B', pageStart: 5, pageEnd: 9, category: 'editorial' },
		]);

		const result = evalExpr(`evalPkg.computeBoundaryAccuracy(${expected}, ${actual})`) as number;

		expect(result).toBeGreaterThan(0.0);
		expect(result).toBeLessThan(1.0);
	});

	// ─── QA-09: Entity precision/recall/F1 correct ───

	it('QA-09: computeEntityPrecisionRecallF1 returns correct deterministic precision, recall, F1', () => {
		// 2 expected persons, 2 actual persons (1 match: "Alice"), plus 1 extra actual
		// Person: precision = 1/2, recall = 1/2, F1 = 0.5
		const expected = JSON.stringify([
			{ name: 'Alice', type: 'person' },
			{ name: 'Bob', type: 'person' },
		]);
		const actual = JSON.stringify([
			{ name: 'Alice', type: 'person', confidence: 0.9, mentions: [] },
			{ name: 'Charlie', type: 'person', confidence: 0.8, mentions: [] },
		]);

		const result = evalExpr(`evalPkg.computeEntityPrecisionRecallF1(${expected}, ${actual})`) as {
			byType: Record<string, { precision: number; recall: number; f1: number }>;
			overall: { precision: number; recall: number; f1: number };
		};

		expect(result).toHaveProperty('byType');
		expect(result).toHaveProperty('overall');
		expect(result.byType).toHaveProperty('person');

		// Person: 1 matched out of 2 actual (precision = 0.5), 1 matched out of 2 expected (recall = 0.5)
		expect(result.byType.person.precision).toBe(0.5);
		expect(result.byType.person.recall).toBe(0.5);
		expect(result.byType.person.f1).toBe(0.5);

		// Overall should equal per-type since there's only one type
		expect(result.overall.precision).toBe(0.5);
		expect(result.overall.recall).toBe(0.5);
		expect(result.overall.f1).toBe(0.5);
	});

	// ─── QA-10: Perfect entity match returns 1.0 ───

	it('QA-10: computeEntityPrecisionRecallF1 returns 1.0 for precision, recall, F1 with identical lists', () => {
		const entities = JSON.stringify([
			{ name: 'Alice', type: 'person', confidence: 0.9, mentions: [] },
			{ name: 'Berlin', type: 'location', confidence: 0.95, mentions: [] },
		]);

		const expected = JSON.stringify([
			{ name: 'Alice', type: 'person' },
			{ name: 'Berlin', type: 'location' },
		]);

		const result = evalExpr(`evalPkg.computeEntityPrecisionRecallF1(${expected}, ${entities})`) as {
			byType: Record<string, { precision: number; recall: number; f1: number }>;
			overall: { precision: number; recall: number; f1: number };
		};

		expect(result.overall.precision).toBe(1.0);
		expect(result.overall.recall).toBe(1.0);
		expect(result.overall.f1).toBe(1.0);
	});

	// ─── QA-11: Relationship metrics correct ───

	it('QA-11: computeRelationshipPrecisionRecallF1 returns expected precision, recall, F1', () => {
		const expected = JSON.stringify([
			{ sourceEntity: 'Alice', targetEntity: 'Event X', relationshipType: 'WITNESSED' },
			{ sourceEntity: 'Bob', targetEntity: 'Event X', relationshipType: 'INVESTIGATED' },
		]);
		// 1 match (Alice-Event X-WITNESSED), 1 extra (Charlie), missing Bob
		const actual = JSON.stringify([
			{ source_entity: 'Alice', target_entity: 'Event X', relationship_type: 'WITNESSED', confidence: 0.9 },
			{ source_entity: 'Charlie', target_entity: 'Event X', relationship_type: 'WITNESSED', confidence: 0.7 },
		]);

		const result = evalExpr(`evalPkg.computeRelationshipPrecisionRecallF1(${expected}, ${actual})`) as {
			precision: number;
			recall: number;
			f1: number;
		};

		// 1 matched out of 2 actual = precision 0.5
		// 1 matched out of 2 expected = recall 0.5
		// F1 = 2 * 0.5 * 0.5 / (0.5 + 0.5) = 0.5
		expect(result.precision).toBe(0.5);
		expect(result.recall).toBe(0.5);
		expect(result.f1).toBe(0.5);
	});

	// ─── QA-12: Segmentation eval runner produces results ───

	it('QA-12: runSegmentationEval() returns SegmentationEvalResult with one entry per golden document and correct summary', () => {
		const result = evalExprAsync(
			`evalPkg.runSegmentationEval(${JSON.stringify(SEGMENTATION_GOLDEN_DIR)}, ${JSON.stringify(SEGMENTS_FIXTURE_DIR)})`,
		) as {
			timestamp: string;
			documents: Array<{
				sourceSlug: string;
				difficulty: string;
				boundaryAccuracy: number;
				segmentCountExact: boolean;
				actualSegmentCount: number;
				expectedSegmentCount: number;
			}>;
			summary: {
				totalDocuments: number;
				avgBoundaryAccuracy: number;
				segmentCountExactRatio: number;
				byDifficulty: Record<string, { avgBoundaryAccuracy: number; count: number }>;
			};
		};

		// Must have a timestamp
		expect(result.timestamp).toBeDefined();
		expect(typeof result.timestamp).toBe('string');

		// Must have documents array with one entry per golden document
		const goldenFiles = readdirSync(SEGMENTATION_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(result.documents.length).toBe(goldenFiles.length);

		// Each document result must have required fields
		for (const doc of result.documents) {
			expect(typeof doc.sourceSlug).toBe('string');
			expect(typeof doc.difficulty).toBe('string');
			expect(typeof doc.boundaryAccuracy).toBe('number');
			expect(typeof doc.segmentCountExact).toBe('boolean');
			expect(typeof doc.actualSegmentCount).toBe('number');
			expect(typeof doc.expectedSegmentCount).toBe('number');

			// Boundary accuracy should be between 0 and 1
			expect(doc.boundaryAccuracy).toBeGreaterThanOrEqual(0);
			expect(doc.boundaryAccuracy).toBeLessThanOrEqual(1);
		}

		// Summary must have correct structure
		expect(result.summary.totalDocuments).toBe(goldenFiles.length);
		expect(result.summary.totalDocuments).toBeGreaterThanOrEqual(3);
		expect(typeof result.summary.avgBoundaryAccuracy).toBe('number');
		expect(typeof result.summary.segmentCountExactRatio).toBe('number');
		expect(typeof result.summary.byDifficulty).toBe('object');
	});

	// ─── QA-13: Entity eval runner produces results ───

	it('QA-13: runEntityEval() returns EntityEvalResult with one entry per golden segment, per-type metrics, and summary', () => {
		const result = evalExprAsync(
			`evalPkg.runEntityEval(${JSON.stringify(ENTITY_GOLDEN_DIR)}, ${JSON.stringify(ENTITIES_FIXTURE_DIR)})`,
		) as {
			timestamp: string;
			segments: Array<{
				segmentId: string;
				sourceSlug: string;
				difficulty: string;
				byType: Record<string, { precision: number; recall: number; f1: number }>;
				overall: { precision: number; recall: number; f1: number };
				relationships: { precision: number; recall: number; f1: number };
			}>;
			summary: {
				totalSegments: number;
				byType: Record<string, { avgPrecision: number; avgRecall: number; avgF1: number; count: number }>;
				overall: { avgPrecision: number; avgRecall: number; avgF1: number };
				relationships: { avgPrecision: number; avgRecall: number; avgF1: number };
				byDifficulty: Record<string, { avgF1: number; count: number }>;
			};
		};

		// Must have a timestamp
		expect(result.timestamp).toBeDefined();
		expect(typeof result.timestamp).toBe('string');

		// Must have segments array with one entry per golden segment
		const goldenFiles = readdirSync(ENTITY_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(result.segments.length).toBe(goldenFiles.length);

		// Each segment result must have required fields
		for (const seg of result.segments) {
			expect(typeof seg.segmentId).toBe('string');
			expect(typeof seg.sourceSlug).toBe('string');
			expect(typeof seg.difficulty).toBe('string');
			expect(typeof seg.byType).toBe('object');
			expect(typeof seg.overall).toBe('object');
			expect(typeof seg.relationships).toBe('object');

			// Overall metrics should be between 0 and 1
			expect(seg.overall.precision).toBeGreaterThanOrEqual(0);
			expect(seg.overall.precision).toBeLessThanOrEqual(1);
			expect(seg.overall.recall).toBeGreaterThanOrEqual(0);
			expect(seg.overall.recall).toBeLessThanOrEqual(1);
			expect(seg.overall.f1).toBeGreaterThanOrEqual(0);
			expect(seg.overall.f1).toBeLessThanOrEqual(1);
		}

		// Summary must have correct structure
		expect(result.summary.totalSegments).toBe(goldenFiles.length);
		expect(result.summary.totalSegments).toBeGreaterThanOrEqual(5);
		expect(typeof result.summary.byType).toBe('object');
		expect(typeof result.summary.overall).toBe('object');
		expect(typeof result.summary.relationships).toBe('object');
		expect(typeof result.summary.byDifficulty).toBe('object');

		// Overall summary metrics should be between 0 and 1
		expect(result.summary.overall.avgPrecision).toBeGreaterThanOrEqual(0);
		expect(result.summary.overall.avgPrecision).toBeLessThanOrEqual(1);
		expect(result.summary.overall.avgRecall).toBeGreaterThanOrEqual(0);
		expect(result.summary.overall.avgRecall).toBeLessThanOrEqual(1);
		expect(result.summary.overall.avgF1).toBeGreaterThanOrEqual(0);
		expect(result.summary.overall.avgF1).toBeLessThanOrEqual(1);
	});

	// ─── QA-14: Baseline file includes segmentation + entity sections ───

	it('QA-14: eval/metrics/baseline.json is valid JSON with "segmentation" and "entities" keys containing valid result structures', () => {
		expect(existsSync(BASELINE_PATH)).toBe(true);

		const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));

		// Must have segmentation key
		expect(raw).toHaveProperty('segmentation');
		const seg = raw.segmentation;
		expect(seg).toHaveProperty('timestamp');
		expect(typeof seg.timestamp).toBe('string');
		expect(seg).toHaveProperty('documents');
		expect(Array.isArray(seg.documents)).toBe(true);
		expect(seg).toHaveProperty('summary');
		expect(typeof seg.summary.totalDocuments).toBe('number');
		expect(typeof seg.summary.avgBoundaryAccuracy).toBe('number');
		expect(typeof seg.summary.segmentCountExactRatio).toBe('number');
		expect(typeof seg.summary.byDifficulty).toBe('object');

		// Must have entities key
		expect(raw).toHaveProperty('entities');
		const ent = raw.entities;
		expect(ent).toHaveProperty('timestamp');
		expect(typeof ent.timestamp).toBe('string');
		expect(ent).toHaveProperty('segments');
		expect(Array.isArray(ent.segments)).toBe(true);
		expect(ent).toHaveProperty('summary');
		expect(typeof ent.summary.totalSegments).toBe('number');
		expect(typeof ent.summary.byType).toBe('object');
		expect(typeof ent.summary.overall).toBe('object');
		expect(typeof ent.summary.relationships).toBe('object');
		expect(typeof ent.summary.byDifficulty).toBe('object');
	});

	// ─── QA-15: Eval package builds ───

	it('QA-15: pnpm turbo run build --filter=@mulder/eval succeeds with no errors', () => {
		const result = spawnSync('pnpm', ['turbo', 'run', 'build', '--filter=@mulder/eval'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 120000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		expect(result.status).toBe(0);
	}, 120000);

	// ─── QA-16: All five entity types covered ───

	it('QA-16: entity golden set covers all five ontology types: person, location, organization, event, document', () => {
		const files = readdirSync(ENTITY_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		const entityTypes = new Set<string>();

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(ENTITY_GOLDEN_DIR, file), 'utf-8'));
			for (const entity of content.expectedEntities) {
				entityTypes.add(entity.type);
			}
		}

		expect(entityTypes.has('person'), 'Missing entity type: person').toBe(true);
		expect(entityTypes.has('location'), 'Missing entity type: location').toBe(true);
		expect(entityTypes.has('organization'), 'Missing entity type: organization').toBe(true);
		expect(entityTypes.has('event'), 'Missing entity type: event').toBe(true);
		expect(entityTypes.has('document'), 'Missing entity type: document').toBe(true);
	});

	// ─── QA-17: Difficulty coverage (segmentation) ───

	it('QA-17: segmentation golden set has at least 1 simple, 1 moderate, and 1 complex document', () => {
		const files = readdirSync(SEGMENTATION_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		const difficulties = new Set<string>();

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(SEGMENTATION_GOLDEN_DIR, file), 'utf-8'));
			difficulties.add(content.difficulty);
		}

		expect(difficulties.has('simple'), 'Missing difficulty: simple').toBe(true);
		expect(difficulties.has('moderate'), 'Missing difficulty: moderate').toBe(true);
		expect(difficulties.has('complex'), 'Missing difficulty: complex').toBe(true);
	});

	// ─── QA-18: Difficulty coverage (entities) ───

	it('QA-18: entity golden set has at least 1 simple, 1 moderate, and 1 complex segment', () => {
		const files = readdirSync(ENTITY_GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		const difficulties = new Set<string>();

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(ENTITY_GOLDEN_DIR, file), 'utf-8'));
			difficulties.add(content.difficulty);
		}

		expect(difficulties.has('simple'), 'Missing difficulty: simple').toBe(true);
		expect(difficulties.has('moderate'), 'Missing difficulty: moderate').toBe(true);
		expect(difficulties.has('complex'), 'Missing difficulty: complex').toBe(true);
	});
});
