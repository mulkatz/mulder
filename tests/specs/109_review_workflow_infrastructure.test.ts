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
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');

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

function writeMinimalConfigWithoutReviewWorkflow(): string {
	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec109-'));
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec109"',
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
			'    - name: "person"',
			'      description: "Person"',
			'  relationships: []',
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function cleanTables(): void {
	truncateExistingTables(['review_events', 'review_artifacts', ...MULDER_TEST_TABLES]);
}

async function createTextSource(label = 'spec109') {
	return coreModule.createSource(pool, {
		filename: `${label}-${randomUUID()}.md`,
		storagePath: `raw/${label}-${randomUUID()}.md`,
		fileHash: `${label}-${randomUUID()}`,
		sourceType: 'text',
		formatMetadata: { media_type: 'text/markdown' },
		pageCount: 1,
		hasNativeText: true,
		nativeTextRatio: 1,
	});
}

async function createStory(label = 'spec109') {
	const source = await createTextSource(label);
	await coreModule.updateSourceStatus(pool, source.id, 'segmented');
	const story = await coreModule.createStory(pool, {
		sourceId: source.id,
		title: `Spec 109 Story ${label}`,
		gcsMarkdownUri: `segments/${source.id}/story.md`,
		gcsMetadataUri: `segments/${source.id}/story.meta.json`,
		extractionConfidence: 0.95,
	});
	await coreModule.updateStoryStatus(pool, story.id, 'segmented');
	return { source, story };
}

async function createSharedEntity(name = `Spec 109 Entity ${randomUUID()}`) {
	return coreModule.upsertEntityByNameType(pool, {
		name,
		type: 'person',
		attributes: {},
		provenance: { sourceDocumentIds: [] },
	});
}

function confidenceMetadata(): import('@mulder/core').ConfidenceMetadata {
	return {
		witnessCount: 1,
		measurementBased: false,
		contemporaneous: true,
		corroborated: false,
		peerReviewed: false,
		authorIsInterpreter: false,
	};
}

async function createAssertionFixture(label: string, claim: string) {
	const { source, story } = await createStory(label);
	const assertion = await coreModule.upsertKnowledgeAssertion(pool, {
		sourceId: source.id,
		storyId: story.id,
		assertionType: 'observation',
		content: claim,
		confidenceMetadata: confidenceMetadata(),
		extractedEntityIds: [],
		provenance: { sourceDocumentIds: [source.id] },
		sensitivityLevel: 'internal',
		sensitivityMetadata: {
			level: 'internal',
			reason: 'fixture',
			assignedBy: 'llm_auto',
			assignedAt: '2026-05-06T00:00:00.000Z',
			piiTypes: [],
			declassifyDate: null,
		},
	});
	return { source, story, assertion };
}

async function createArtifact(
	overrides?: Partial<import('@mulder/core').UpsertReviewableArtifactInput>,
): Promise<import('@mulder/core').ReviewableArtifact> {
	return coreModule.upsertReviewableArtifact(pool, {
		artifactType: 'assertion_classification',
		subjectId: randomUUID(),
		subjectTable: 'knowledge_assertions',
		createdBy: 'llm_auto',
		reviewStatus: 'pending',
		currentValue: { assertion_type: 'observation', confidence: 0.94 },
		context: { story_title: 'Spec 109' },
		...overrides,
	});
}

beforeAll(async () => {
	buildPackage(CORE_DIR);
	buildPackage(CLI_DIR);
	coreModule = await import(pathToFileURL(CORE_DIST).href);

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
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('Spec 109: review workflow infrastructure', () => {
	it.skipIf(!pgAvailable)('QA-01: review schema is constrained and idempotent', async () => {
		const tables = db.runSql(
			[
				'SELECT table_name',
				'FROM information_schema.tables',
				"WHERE table_schema = 'public'",
				"  AND table_name IN ('review_artifacts', 'review_events', 'review_queues')",
				'ORDER BY table_name;',
			].join('\n'),
		);
		expect(tables).toContain('review_artifacts');
		expect(tables).toContain('review_events');
		expect(tables).toContain('review_queues');

		const checks = db.runSql(
			[
				"SELECT string_agg(pg_get_constraintdef(oid), E'\\n' ORDER BY conname)",
				'FROM pg_constraint',
				"WHERE conrelid IN ('review_artifacts'::regclass, 'review_events'::regclass)",
				"  AND contype = 'c';",
			].join('\n'),
		);
		for (const value of ['pending', 'approved', 'auto_approved', 'corrected', 'contested', 'rejected']) {
			expect(checks).toContain(value);
		}
		for (const value of ['approve', 'correct', 'reject', 'comment', 'escalate']) {
			expect(checks).toContain(value);
		}
		expect(checks).toContain('jsonb_typeof(current_value)');
		expect(checks).toContain('jsonb_typeof(context)');

		const indexes = db.runSql(
			[
				'SELECT indexname',
				'FROM pg_indexes',
				"WHERE schemaname = 'public'",
				"  AND indexname IN ('idx_review_artifacts_active_subject', 'idx_review_artifacts_pending_scan', 'idx_review_events_artifact_history')",
				'ORDER BY indexname;',
			].join('\n'),
		);
		expect(indexes).toContain('idx_review_artifacts_active_subject');
		expect(indexes).toContain('idx_review_artifacts_pending_scan');
		expect(indexes).toContain('idx_review_events_artifact_history');

		const queues = await coreModule.listReviewQueues(pool);
		expect(queues.map((queue) => queue.queueKey).sort()).toEqual([
			'conflicts',
			'contested_artifacts',
			'credibility_profiles',
		]);
	});

	it('QA-02: config exposes A13 defaults', () => {
		const config = coreModule.loadConfig(
			writeMinimalConfigWithoutReviewWorkflow(),
		) as import('@mulder/core').MulderConfig;
		expect(config.review_workflow.enabled).toBe(true);
		expect(config.review_workflow.artifact_types.assertion_classification).toMatchObject({
			review_depth: 'spot_check',
			spot_check_percentage: 20,
			auto_approve_after_hours: 168,
			auto_approve_min_confidence: 0.9,
		});
		expect(config.review_workflow.artifact_types.credibility_profile).toMatchObject({
			review_depth: 'double_review',
			auto_approve_after_hours: null,
			escalation_reviewer: null,
		});
		expect(config.review_workflow.artifact_types.taxonomy_mapping.auto_approve_after_hours).toBe(336);
		expect(config.review_workflow.artifact_types.similar_case_link.auto_approve_after_hours).toBe(168);
		expect(config.review_workflow.artifact_types.agent_finding.auto_approve_after_hours).toBeNull();
		expect(config.review_workflow.metrics).toEqual({
			track_accuracy: true,
			auto_adjust_depth: true,
			accuracy_threshold_for_upgrade: 0.7,
			accuracy_threshold_for_downgrade: 0.95,
		});
	});

	it.skipIf(!pgAvailable)('QA-03: artifacts are upserted and listed by queue', async () => {
		const early = new Date('2026-05-01T00:00:00.000Z');
		const credibility = await createArtifact({
			artifactType: 'credibility_profile',
			subjectId: randomUUID(),
			subjectTable: 'source_credibility_profiles',
			currentValue: { source_name: 'Archive A' },
			context: { source_id: randomUUID() },
			dueAt: early,
		});
		const conflict = await createArtifact({
			artifactType: 'conflict_node',
			subjectId: randomUUID(),
			subjectTable: 'conflict_nodes',
			currentValue: { severity: 'significant' },
			context: { participants: 2 },
		});
		const duplicate = await createArtifact({
			artifactType: 'credibility_profile',
			subjectId: credibility.subjectId,
			subjectTable: 'source_credibility_profiles',
			currentValue: { source_name: 'Archive A updated' },
		});

		expect(duplicate.artifactId).toBe(credibility.artifactId);
		expect(await coreModule.listReviewableArtifacts(pool, { reviewStatus: 'pending' })).toHaveLength(2);
		expect(await coreModule.listReviewQueueArtifacts(pool, 'credibility_profiles')).toHaveLength(1);
		expect((await coreModule.listReviewQueueArtifacts(pool, 'conflicts'))[0].artifactId).toBe(conflict.artifactId);

		const queues = await coreModule.listReviewQueues(pool);
		const credibilityQueue = queues.find((queue) => queue.queueKey === 'credibility_profiles');
		expect(credibilityQueue?.pendingCount).toBe(1);
		expect(credibilityQueue?.oldestPending?.toISOString()).toBe(early.toISOString());
	});

	it.skipIf(!pgAvailable)('review blocker: material producer upserts reset stale approved projections', async () => {
		const artifact = await createArtifact();
		await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-a',
			action: 'approve',
			confidence: 'certain',
		});

		const unchanged = await createArtifact({
			subjectId: artifact.subjectId,
			currentValue: { assertion_type: 'observation', confidence: 0.94 },
			context: { story_title: 'Spec 109' },
		});
		const changed = await createArtifact({
			subjectId: artifact.subjectId,
			currentValue: { assertion_type: 'hypothesis', confidence: 0.73 },
			context: { story_title: 'Spec 109 revised' },
		});

		expect(unchanged.reviewStatus).toBe('approved');
		expect(changed.artifactId).toBe(artifact.artifactId);
		expect(changed.reviewStatus).toBe('pending');
		expect(changed.currentValue.assertion_type).toBe('hypothesis');

		await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-a',
			action: 'approve',
			confidence: 'certain',
		});
		const contested = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-b',
			action: 'reject',
			confidence: 'likely',
			rationale: 'The revised projection is disputed.',
		});
		const contestedChanged = await createArtifact({
			subjectId: artifact.subjectId,
			currentValue: { assertion_type: 'interpretation', confidence: 0.68 },
			context: { story_title: 'Spec 109 disputed revision' },
		});

		expect(contested.artifact.reviewStatus).toBe('contested');
		expect(contestedChanged.artifactId).toBe(artifact.artifactId);
		expect(contestedChanged.reviewStatus).toBe('contested');
		expect(contestedChanged.currentValue.assertion_type).toBe('interpretation');
	});

	it.skipIf(!pgAvailable)('QA-04: review events are immutable and update projection status', async () => {
		const artifact = await createArtifact();
		const approved = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-a',
			action: 'approve',
			confidence: 'certain',
		});
		expect(approved.artifact.reviewStatus).toBe('approved');

		const commented = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-a',
			action: 'comment',
			rationale: 'Looks stable.',
			tags: ['note'],
		});
		expect(commented.artifact.reviewStatus).toBe('approved');

		const corrected = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-a',
			action: 'correct',
			newValue: { assertion_type: 'interpretation', confidence: 0.8 },
			confidence: 'likely',
			rationale: 'The sentence interprets an observation.',
		});
		const events = await coreModule.listReviewEvents(pool, artifact.artifactId);

		expect(corrected.artifact.reviewStatus).toBe('corrected');
		expect(corrected.artifact.currentValue.assertion_type).toBe('interpretation');
		expect(events).toHaveLength(3);
		expect(events[0].action).toBe('approve');
		expect(events[2].previousValue).toMatchObject({ assertion_type: 'observation' });
		expect(events[2].newValue).toMatchObject({ assertion_type: 'interpretation' });
	});

	it.skipIf(!pgAvailable)('QA-05: reviewer disagreement becomes contested', async () => {
		const artifact = await createArtifact();
		await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-a',
			action: 'approve',
		});
		const rejected = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-b',
			action: 'reject',
			confidence: 'likely',
			rationale: 'The artifact contradicts the source text.',
		});
		const contestedArtifacts = await coreModule.listReviewQueueArtifacts(pool, 'contested_artifacts');
		const events = await coreModule.listReviewEvents(pool, artifact.artifactId);

		expect(rejected.artifact.reviewStatus).toBe('contested');
		expect(events.map((event) => event.action)).toEqual(['approve', 'reject']);
		expect(contestedArtifacts.map((item) => item.artifactId)).toContain(artifact.artifactId);

		const laterCorrection = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-c',
			action: 'correct',
			newValue: { assertion_type: 'interpretation', confidence: 0.67 },
			rationale: 'A later review position should not resolve the disagreement.',
		});
		expect(laterCorrection.artifact.reviewStatus).toBe('contested');
	});

	it.skipIf(!pgAvailable)('review blocker: divergent same-action corrections become contested', async () => {
		const artifact = await createArtifact();
		const correctionValue = { assertion_type: 'interpretation', confidence: 0.8 };
		await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-a',
			action: 'correct',
			newValue: correctionValue,
			confidence: 'likely',
			rationale: 'The sentence interprets an observation.',
		});
		const matchingCorrection = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-b',
			action: 'correct',
			newValue: correctionValue,
			confidence: 'likely',
			rationale: 'The same correction is appropriate.',
		});
		const divergentCorrection = await coreModule.recordReviewEvent(pool, {
			artifactId: artifact.artifactId,
			reviewerId: 'reviewer-c',
			action: 'correct',
			newValue: { assertion_type: 'hypothesis', confidence: 0.61 },
			confidence: 'likely',
			rationale: 'The corrected value should be weaker.',
		});
		const events = await coreModule.listReviewEvents(pool, artifact.artifactId);

		expect(matchingCorrection.artifact.reviewStatus).toBe('corrected');
		expect(matchingCorrection.artifact.currentValue).toMatchObject(correctionValue);
		expect(divergentCorrection.artifact.reviewStatus).toBe('contested');
		expect(divergentCorrection.artifact.currentValue).toMatchObject({
			assertion_type: 'hypothesis',
			confidence: 0.61,
		});
		expect(events.map((event) => event.action)).toEqual(['correct', 'correct', 'correct']);
		expect(events.map((event) => event.reviewerId)).toEqual(['reviewer-a', 'reviewer-b', 'reviewer-c']);
	});

	it.skipIf(!pgAvailable)('QA-06: auto-approval is explicit', async () => {
		const due = await createArtifact({
			artifactType: 'taxonomy_mapping',
			subjectTable: 'taxonomy',
			dueAt: new Date('2026-05-01T00:00:00.000Z'),
		});
		const result = await coreModule.autoApproveDueReviewArtifacts(pool, {
			artifactTypes: ['taxonomy_mapping'],
			now: new Date('2026-05-06T00:00:00.000Z'),
		});
		const events = await coreModule.listReviewEvents(pool, due.artifactId);

		expect(result.updatedCount).toBe(1);
		expect(result.artifacts[0].reviewStatus).toBe('auto_approved');
		expect(events).toHaveLength(0);
	});

	it.skipIf(!pgAvailable)('QA-07: credibility profiles register review artifacts', async () => {
		const source = await createTextSource('qa07');
		const profile = await coreModule.upsertSourceCredibilityProfile(pool, {
			sourceId: source.id,
			sourceName: 'Spec 109 Source',
			sourceType: 'other',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: [
				{
					dimensionId: 'transparency',
					label: 'Transparency',
					score: 0.7,
					rationale: 'Fixture rationale',
					evidenceRefs: ['fixture'],
				},
			],
		});
		const artifact = await coreModule.findReviewableArtifactBySubject(pool, 'credibility_profile', profile.profileId);

		expect(artifact?.reviewStatus).toBe('pending');
		expect(artifact?.sourceId).toBe(source.id);
		expect(artifact?.currentValue.source_name).toBe('Spec 109 Source');
		expect(artifact?.context.source_id).toBe(source.id);
	});

	it.skipIf(!pgAvailable)('QA-08: conflict nodes and resolutions register review artifacts', async () => {
		const left = await createAssertionFixture('qa08-a', 'A witness observed a silent object.');
		const right = await createAssertionFixture('qa08-b', 'A witness observed a loud object.');
		const conflict = await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'llm_auto',
			detectedBy: 'test',
			severity: 'significant',
			severityRationale: 'The claims disagree on sound.',
			confidence: 0.91,
			assertions: [
				{ assertionId: left.assertion.id, participantRole: 'claim_a', claim: left.assertion.content },
				{ assertionId: right.assertion.id, participantRole: 'claim_b', claim: right.assertion.content },
			],
		});
		const resolved = await coreModule.resolveConflictNode(pool, {
			conflictId: conflict.id,
			resolutionType: 'different_time',
			explanation: 'The claims refer to different times.',
			resolvedBy: 'reviewer',
			evidenceRefs: ['fixture:a', 'fixture:b'],
		});
		const conflictArtifact = await coreModule.findReviewableArtifactBySubject(pool, 'conflict_node', conflict.id);
		const resolutionArtifact = await coreModule.findReviewableArtifactBySubject(
			pool,
			'conflict_resolution',
			resolved.latestResolution?.id ?? randomUUID(),
		);
		const queueArtifacts = await coreModule.listReviewQueueArtifacts(pool, 'conflicts');

		expect(conflictArtifact?.currentValue.severity).toBe('significant');
		expect(conflictArtifact?.context.sensitivity_level).toBe('internal');
		expect(resolutionArtifact?.currentValue.resolution_type).toBe('different_time');
		expect(resolutionArtifact?.currentValue.evidence_refs).toEqual(['fixture:a', 'fixture:b']);
		expect(queueArtifacts.map((artifact) => artifact.artifactType).sort()).toEqual([
			'conflict_node',
			'conflict_resolution',
		]);
	});

	it.skipIf(!pgAvailable)('review blocker: source reset removes multi-source conflict review artifacts', async () => {
		const left = await createAssertionFixture('reset-a', 'A witness observed a silent object.');
		const right = await createAssertionFixture('reset-b', 'A witness observed a loud object.');
		const conflict = await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'llm_auto',
			detectedBy: 'test',
			severity: 'significant',
			severityRationale: 'The claims disagree on sound.',
			confidence: 0.91,
			assertions: [
				{ assertionId: left.assertion.id, participantRole: 'claim_a', claim: left.assertion.content },
				{ assertionId: right.assertion.id, participantRole: 'claim_b', claim: right.assertion.content },
			],
		});
		const resolved = await coreModule.resolveConflictNode(pool, {
			conflictId: conflict.id,
			resolutionType: 'different_time',
			explanation: 'The claims refer to different times.',
			resolvedBy: 'reviewer',
		});
		const conflictArtifact = await coreModule.findReviewableArtifactBySubject(pool, 'conflict_node', conflict.id);

		expect(conflictArtifact?.sourceId).toBeNull();
		await coreModule.resetPipelineStep(pool, left.source.id, 'enrich');

		await expect(coreModule.findReviewableArtifactBySubject(pool, 'conflict_node', conflict.id)).resolves.toBeNull();
		await expect(
			coreModule.findReviewableArtifactBySubject(
				pool,
				'conflict_resolution',
				resolved.latestResolution?.id ?? randomUUID(),
			),
		).resolves.toBeNull();
	});

	it.skipIf(!pgAvailable)('review blocker: graph reset preserves credibility review artifacts', async () => {
		const left = await createAssertionFixture('graph-reset-a', 'A witness observed a silent object.');
		const right = await createAssertionFixture('graph-reset-b', 'A witness observed a loud object.');
		const profile = await coreModule.upsertSourceCredibilityProfile(pool, {
			sourceId: left.source.id,
			sourceName: 'Graph Reset Source',
			sourceType: 'other',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: [
				{
					dimensionId: 'consistency',
					label: 'Consistency',
					score: 0.42,
					rationale: 'Fixture rationale',
					evidenceRefs: ['fixture'],
				},
			],
		});
		const entity = await createSharedEntity();
		const edge = await coreModule.createEdge(pool, {
			sourceEntityId: entity.id,
			targetEntityId: entity.id,
			relationship: 'contradicts',
			edgeType: 'POTENTIAL_CONTRADICTION',
			storyId: left.story.id,
			confidence: 0.5,
			attributes: {
				storyIdA: left.story.id,
				storyIdB: right.story.id,
			},
			provenance: { sourceDocumentIds: [left.source.id, right.source.id] },
		});
		const conflict = await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'llm_auto',
			detectedBy: 'test',
			severity: 'significant',
			severityRationale: 'The claims disagree on sound.',
			confidence: 0.91,
			legacyEdgeId: edge.id,
			assertions: [
				{ assertionId: left.assertion.id, participantRole: 'claim_a', claim: left.assertion.content },
				{ assertionId: right.assertion.id, participantRole: 'claim_b', claim: right.assertion.content },
			],
		});
		const resolved = await coreModule.resolveConflictNode(pool, {
			conflictId: conflict.id,
			resolutionType: 'different_time',
			explanation: 'The claims refer to different times.',
			resolvedBy: 'reviewer',
			legacyEdgeId: edge.id,
		});
		const credibilityArtifact = await coreModule.findReviewableArtifactBySubject(
			pool,
			'credibility_profile',
			profile.profileId,
		);
		const resolutionId = resolved.latestResolution?.id ?? randomUUID();

		expect(credibilityArtifact?.sourceId).toBe(left.source.id);
		await coreModule.resetPipelineStep(pool, left.source.id, 'graph');

		await expect(
			coreModule.findReviewableArtifactBySubject(pool, 'credibility_profile', profile.profileId),
		).resolves.toMatchObject({
			artifactId: credibilityArtifact?.artifactId,
			reviewStatus: 'pending',
		});
		await expect(coreModule.findReviewableArtifactBySubject(pool, 'conflict_node', conflict.id)).resolves.toBeNull();
		await expect(
			coreModule.findReviewableArtifactBySubject(pool, 'conflict_resolution', resolutionId),
		).resolves.toBeNull();
	});

	it.skipIf(!pgAvailable)('review blocker: source purge removes multi-source conflict review artifacts', async () => {
		const left = await createAssertionFixture('purge-a', 'A witness observed a silent object.');
		const right = await createAssertionFixture('purge-b', 'A witness observed a loud object.');
		const conflict = await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'llm_auto',
			detectedBy: 'test',
			severity: 'significant',
			severityRationale: 'The claims disagree on sound.',
			confidence: 0.91,
			assertions: [
				{ assertionId: left.assertion.id, participantRole: 'claim_a', claim: left.assertion.content },
				{ assertionId: right.assertion.id, participantRole: 'claim_b', claim: right.assertion.content },
			],
		});
		const resolved = await coreModule.resolveConflictNode(pool, {
			conflictId: conflict.id,
			resolutionType: 'different_time',
			explanation: 'The claims refer to different times.',
			resolvedBy: 'reviewer',
		});
		const resolutionId = resolved.latestResolution?.id ?? randomUUID();

		await coreModule.softDeleteSource(pool, {
			sourceId: left.source.id,
			actor: 'spec109-test',
			reason: 'source removed',
		});
		await coreModule.purgeSource(pool, {
			sourceId: left.source.id,
			actor: 'spec109-test',
			reason: 'source removed',
			confirmed: true,
		});

		expect(
			Number(
				db.runSql(`
					SELECT COUNT(*)
					FROM review_artifacts
					WHERE subject_id IN ('${conflict.id}', '${resolutionId}')
				`),
			),
		).toBe(0);
	});

	it.skipIf(!pgAvailable)(
		'review blocker: restoring a source restores review artifacts and retains events',
		async () => {
			const source = await createTextSource('restore-review');
			const profile = await coreModule.upsertSourceCredibilityProfile(pool, {
				sourceId: source.id,
				sourceName: 'Restorable Source',
				sourceType: 'other',
				profileAuthor: 'llm_auto',
				reviewStatus: 'draft',
				dimensions: [
					{
						dimensionId: 'transparency',
						label: 'Transparency',
						score: 0.55,
						rationale: 'Fixture rationale',
						evidenceRefs: ['fixture'],
					},
				],
			});
			const artifact = await coreModule.findReviewableArtifactBySubject(pool, 'credibility_profile', profile.profileId);
			expect(artifact).not.toBeNull();
			if (!artifact) throw new Error('Expected credibility profile review artifact');

			await coreModule.recordReviewEvent(pool, {
				artifactId: artifact.artifactId,
				reviewerId: 'reviewer-a',
				action: 'approve',
				confidence: 'certain',
			});
			const deletedAt = new Date('2026-05-06T09:00:00.000Z');
			await coreModule.softDeleteSource(pool, {
				sourceId: source.id,
				actor: 'spec109-test',
				reason: 'temporary rollback',
				deletedAt,
				undoWindowHours: 24,
			});

			await expect(
				coreModule.findReviewableArtifactBySubject(pool, 'credibility_profile', profile.profileId),
			).resolves.toBeNull();

			await coreModule.restoreSource(pool, {
				sourceId: source.id,
				actor: 'spec109-test',
				reason: 'rollback cancelled',
				restoredAt: new Date('2026-05-06T10:00:00.000Z'),
			});
			const restored = await coreModule.findReviewableArtifactBySubject(pool, 'credibility_profile', profile.profileId);
			const events = await coreModule.listReviewEvents(pool, artifact.artifactId);

			expect(restored).toMatchObject({
				artifactId: artifact.artifactId,
				reviewStatus: 'approved',
				sourceId: source.id,
			});
			expect(events.map((event) => event.action)).toEqual(['approve']);
		},
	);
});
