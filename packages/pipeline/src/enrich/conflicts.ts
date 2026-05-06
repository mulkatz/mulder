import type {
	ConflictSeverity,
	ConflictType,
	ContradictionManagementConfig,
	KnowledgeAssertion,
	Logger,
	MulderConfig,
	Services,
	StepError,
} from '@mulder/core';
import {
	createChildLogger,
	createConflictNode,
	ENRICH_ERROR_CODES,
	mergeSensitivityMetadata,
	renderPrompt,
} from '@mulder/core';
import type pg from 'pg';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';

const conflictDetectionSchema = z.object({
	is_conflict: z.boolean(),
	conflict_type: z.enum(['factual', 'interpretive', 'taxonomic', 'temporal', 'spatial', 'attributive']),
	severity: z.enum(['minor', 'significant', 'fundamental']),
	severity_rationale: z.string().min(1),
	confidence: z.number().min(0).max(1),
	claim_a: z.string().min(1),
	claim_b: z.string().min(1),
});

const conflictDetectionSchemaV3 = z3.object({
	is_conflict: z3.boolean(),
	conflict_type: z3.enum(['factual', 'interpretive', 'taxonomic', 'temporal', 'spatial', 'attributive']),
	severity: z3.enum(['minor', 'significant', 'fundamental']),
	severity_rationale: z3.string().min(1),
	confidence: z3.number().min(0).max(1),
	claim_a: z3.string().min(1),
	claim_b: z3.string().min(1),
});

const conflictDetectionJsonSchema: Record<string, unknown> = zodToJsonSchema(conflictDetectionSchemaV3, {
	$refStrategy: 'none',
});

interface ConflictCandidateAssertion {
	id: string;
	sourceId: string;
	storyId: string;
	assertionType: KnowledgeAssertion['assertionType'];
	content: string;
	extractedEntityIds: string[];
	sensitivityMetadata: KnowledgeAssertion['sensitivityMetadata'];
}

export interface AssertionConflictDetectionResult {
	candidatesExamined: number;
	conflictsCreated: number;
	skipped: number;
	failures: number;
	errors: StepError[];
}

interface AssertionRow {
	id: string;
	source_id: string;
	story_id: string;
	assertion_type: KnowledgeAssertion['assertionType'];
	content: string;
	extracted_entity_ids: string[];
	provenance: unknown;
	sensitivity_metadata: unknown;
	sensitivity_level: KnowledgeAssertion['sensitivityLevel'];
}

function mapAssertionRow(row: AssertionRow): ConflictCandidateAssertion {
	return {
		id: row.id,
		sourceId: row.source_id,
		storyId: row.story_id,
		assertionType: row.assertion_type,
		content: row.content,
		extractedEntityIds: Array.isArray(row.extracted_entity_ids) ? row.extracted_entity_ids.map(String) : [],
		sensitivityMetadata: mergeSensitivityMetadata([row.sensitivity_metadata], row.sensitivity_level ?? 'internal'),
	};
}

function toCandidateAssertion(assertion: KnowledgeAssertion): ConflictCandidateAssertion {
	return {
		id: assertion.id,
		sourceId: assertion.sourceId,
		storyId: assertion.storyId,
		assertionType: assertion.assertionType,
		content: assertion.content,
		extractedEntityIds: assertion.extractedEntityIds,
		sensitivityMetadata: assertion.sensitivityMetadata,
	};
}

async function loadCandidates(
	pool: pg.Pool,
	assertion: KnowledgeAssertion,
	config: ContradictionManagementConfig,
	remainingLimit: number,
): Promise<ConflictCandidateAssertion[]> {
	if (remainingLimit <= 0) return [];
	if (config.detection.require_shared_entity && assertion.extractedEntityIds.length === 0) return [];

	const result = await pool.query<AssertionRow>(
		`
			SELECT existing.*
			FROM knowledge_assertions existing
			JOIN sources existing_source ON existing_source.id = existing.source_id
			WHERE existing.deleted_at IS NULL
				AND existing.id <> $1
				AND existing.story_id <> $2
				AND existing.source_id <> $3
				AND ($7::boolean = false OR existing.extracted_entity_ids && $4::uuid[])
				AND existing_source.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
				AND NOT EXISTS (
					SELECT 1
					FROM conflict_nodes cn
					WHERE cn.deleted_at IS NULL
						AND cn.conflict_type = ANY($5::text[])
						AND cn.canonical_assertion_pair = ARRAY[
							LEAST(existing.id, $1::uuid),
							GREATEST(existing.id, $1::uuid)
						]::uuid[]
				)
			ORDER BY existing.created_at DESC, existing.id ASC
			LIMIT $6
		`,
		[
			assertion.id,
			assertion.storyId,
			assertion.sourceId,
			assertion.extractedEntityIds,
			config.conflict_types,
			remainingLimit,
			config.detection.require_shared_entity,
		],
	);
	return result.rows.map(mapAssertionRow);
}

function sharedEntityIds(left: ConflictCandidateAssertion, right: ConflictCandidateAssertion): string[] {
	const rightIds = new Set(right.extractedEntityIds);
	return left.extractedEntityIds.filter((id) => rightIds.has(id)).sort();
}

function resolveLocale(config: MulderConfig): string {
	return config.project.supported_locales[0] ?? 'en';
}

function isEnabledConflictType(value: ConflictType, config: ContradictionManagementConfig): boolean {
	return config.conflict_types.includes(value);
}

function isEnabledSeverity(value: ConflictSeverity, config: ContradictionManagementConfig): boolean {
	return config.severity_levels.includes(value);
}

export async function detectAssertionConflicts(input: {
	storyId: string;
	assertions: readonly KnowledgeAssertion[];
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	logger: Logger;
}): Promise<AssertionConflictDetectionResult> {
	const result: AssertionConflictDetectionResult = {
		candidatesExamined: 0,
		conflictsCreated: 0,
		skipped: 0,
		failures: 0,
		errors: [],
	};
	const config = input.config.contradiction_management;
	const log = createChildLogger(input.logger, { module: 'assertion-conflict-detection', storyId: input.storyId });

	if (!config.enabled || !config.detection.pipeline || !config.detection.llm_confirmation) {
		result.skipped = input.assertions.length;
		return result;
	}

	const maxCandidates = config.detection.max_candidates_per_story;
	const newAssertionIds = new Set(input.assertions.map((assertion) => assertion.id));

	for (const assertion of input.assertions) {
		const remaining = maxCandidates - result.candidatesExamined;
		if (remaining <= 0) break;
		const candidates = await loadCandidates(input.pool, assertion, config, remaining);

		for (const candidate of candidates) {
			if (result.candidatesExamined >= maxCandidates) break;
			if (newAssertionIds.has(candidate.id)) {
				result.skipped++;
				continue;
			}
			const current = toCandidateAssertion(assertion);
			const overlap = sharedEntityIds(current, candidate);
			if (config.detection.require_shared_entity && overlap.length === 0) {
				result.skipped++;
				continue;
			}
			result.candidatesExamined++;

			try {
				const response = await input.services.llm.generateStructured<z.infer<typeof conflictDetectionSchema>>({
					prompt: renderPrompt('detect-assertion-conflict', {
						locale: resolveLocale(input.config),
						assertion_a: {
							id: assertion.id,
							assertion_type: assertion.assertionType,
							claim: assertion.content,
							source_id: assertion.sourceId,
						},
						assertion_b: {
							id: candidate.id,
							assertion_type: candidate.assertionType,
							claim: candidate.content,
							source_id: candidate.sourceId,
						},
						shared_entities: overlap.join(', '),
					}),
					schema: conflictDetectionJsonSchema,
					responseValidator: (data) => conflictDetectionSchema.parse(data),
				});
				if (!response.is_conflict || response.confidence < config.detection.min_confidence) {
					result.skipped++;
					continue;
				}
				if (!isEnabledConflictType(response.conflict_type, config) || !isEnabledSeverity(response.severity, config)) {
					result.skipped++;
					log.warn(
						{
							assertionId: assertion.id,
							candidateId: candidate.id,
							conflictType: response.conflict_type,
							severity: response.severity,
						},
						'Conflict detection returned a disabled type or severity',
					);
					continue;
				}
				await createConflictNode(input.pool, {
					conflictType: response.conflict_type,
					detectionMethod: 'llm_auto',
					detectedBy: `enrich:${input.storyId}`,
					severity: response.severity,
					severityRationale: response.severity_rationale,
					confidence: response.confidence,
					assertions: [
						{ assertionId: assertion.id, participantRole: 'claim_a', claim: response.claim_a },
						{ assertionId: candidate.id, participantRole: 'claim_b', claim: response.claim_b },
					],
					provenance: {
						sourceDocumentIds: [assertion.sourceId, candidate.sourceId],
					},
					sensitivityMetadata: mergeSensitivityMetadata([assertion.sensitivityMetadata, candidate.sensitivityMetadata]),
				});
				result.conflictsCreated++;
			} catch (cause: unknown) {
				const message = cause instanceof Error ? cause.message : String(cause);
				result.failures++;
				result.errors.push({
					code: ENRICH_ERROR_CODES.ENRICH_LLM_FAILED,
					message: `Assertion conflict detection failed for ${assertion.id}: ${message}`,
				});
				log.warn({ err: cause, assertionId: assertion.id, candidateId: candidate.id }, 'Conflict detection failed');
			}
		}
	}

	return result;
}
