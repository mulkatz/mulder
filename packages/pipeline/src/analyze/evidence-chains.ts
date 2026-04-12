/**
 * Evidence chain computation for the Analyze step.
 *
 * Resolves thesis queries to seed entities deterministically, then traces
 * supporting relationship paths with a recursive CTE and collects
 * confirmed contradiction edges that touch those same seeds.
 *
 * @see docs/specs/63_evidence_chains.spec.md §4.4
 * @see docs/functional-spec.md §2.8, §5.1
 */

import type { MulderConfig } from '@mulder/core';
import { ANALYZE_ERROR_CODES, AnalyzeError, createChildLogger, createLogger } from '@mulder/core';
import { extractQueryEntities } from '@mulder/retrieval';
import type pg from 'pg';

export interface EvidenceChainPath {
	path: string[];
	strength: number;
	supports: boolean;
}

export interface EvidenceChainThesisComputation {
	thesis: string;
	seedIds: string[];
	supportingChains: EvidenceChainPath[];
	contradictionChains: EvidenceChainPath[];
}

interface TraversalRow {
	entity_id: string;
	path: string[];
	strength: number;
	depth: number;
}

interface ContradictionRow {
	edge_id: string;
	source_entity_id: string;
	target_entity_id: string;
	strength: number;
}

const logger = createLogger();
const moduleLogger = createChildLogger(logger, { module: 'analyze-evidence-chains' });

function normalizeThesis(thesis: string): string {
	return thesis.trim();
}

async function resolveThesisSeedIds(pool: pg.Pool, thesis: string): Promise<string[]> {
	return extractQueryEntities(pool, thesis);
}

function normalizePath(path: string[]): string[] {
	return path.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function dedupeEvidenceChains(chains: EvidenceChainPath[]): EvidenceChainPath[] {
	const seen = new Map<string, EvidenceChainPath>();

	for (const chain of chains) {
		const normalizedPath = normalizePath(chain.path);
		if (normalizedPath.length === 0) {
			continue;
		}

		const key = `${chain.supports ? 'support' : 'contradiction'}:${normalizedPath.join('>')}`;
		const existing = seen.get(key);
		if (!existing || chain.strength > existing.strength) {
			seen.set(key, {
				path: normalizedPath,
				strength: chain.strength,
				supports: chain.supports,
			});
		}
	}

	return [...seen.values()].sort((left, right) => {
		if (right.strength !== left.strength) {
			return right.strength - left.strength;
		}
		return left.path.join('>').localeCompare(right.path.join('>'));
	});
}

async function loadSupportingPaths(
	pool: pg.Pool,
	seedIds: string[],
	maxHops: number,
	supernodeThreshold: number,
): Promise<EvidenceChainPath[]> {
	const sql = `
    WITH RECURSIVE traversal AS (
      SELECT
        e.id AS entity_id,
        ARRAY[e.id]::uuid[] AS path,
        1.0::float AS strength,
        0 AS depth
      FROM entities e
      WHERE e.id = ANY($1::uuid[])

      UNION ALL

      SELECT
        e2.id AS entity_id,
        t.path || e2.id,
        t.strength * COALESCE(ee.confidence, 1.0),
        t.depth + 1
      FROM traversal t
      JOIN entity_edges ee ON ee.source_entity_id = t.entity_id
      JOIN entities e2 ON e2.id = ee.target_entity_id
      WHERE t.depth < $2
        AND ee.edge_type = 'RELATIONSHIP'
        AND NOT e2.id = ANY(t.path)
        AND e2.source_count < $3
    ),
    best_paths AS (
      SELECT DISTINCT ON (entity_id)
        entity_id,
        path,
        strength,
        depth
      FROM traversal
      WHERE depth > 0
      ORDER BY entity_id, strength DESC, depth ASC, array_length(path, 1) ASC
    )
    SELECT entity_id, path, strength, depth
    FROM best_paths
    ORDER BY strength DESC, depth ASC, entity_id
  `;

	try {
		const result = await pool.query<TraversalRow>(sql, [seedIds, maxHops, supernodeThreshold]);
		moduleLogger.debug(
			{
				seedCount: seedIds.length,
				maxHops,
				supernodeThreshold,
				resultCount: result.rows.length,
			},
			'Supporting evidence paths loaded',
		);

		return result.rows.map((row) => ({
			path: normalizePath(row.path),
			strength: Number(row.strength),
			supports: true,
		}));
	} catch (cause: unknown) {
		throw new AnalyzeError('Failed to load supporting evidence paths', ANALYZE_ERROR_CODES.ANALYZE_TRAVERSAL_FAILED, {
			cause,
			context: {
				seedCount: seedIds.length,
				maxHops,
				supernodeThreshold,
			},
		});
	}
}

async function loadContradictionPaths(pool: pg.Pool, seedIds: string[]): Promise<EvidenceChainPath[]> {
	if (seedIds.length === 0) {
		return [];
	}

	const sql = `
    SELECT DISTINCT ON (ee.id)
      ee.id AS edge_id,
      ee.source_entity_id,
      ee.target_entity_id,
      COALESCE(ee.confidence, 1.0) AS strength
    FROM entity_edges ee
    WHERE ee.edge_type = 'CONFIRMED_CONTRADICTION'
      AND (ee.source_entity_id = ANY($1::uuid[]) OR ee.target_entity_id = ANY($1::uuid[]))
    ORDER BY ee.id, strength DESC, ee.source_entity_id, ee.target_entity_id
  `;

	try {
		const result = await pool.query<ContradictionRow>(sql, [seedIds]);
		moduleLogger.debug(
			{ seedCount: seedIds.length, resultCount: result.rows.length },
			'Contradiction evidence paths loaded',
		);

		return result.rows.map((row) => ({
			path: [row.source_entity_id, row.target_entity_id],
			strength: Number(row.strength),
			supports: false,
		}));
	} catch (cause: unknown) {
		throw new AnalyzeError(
			'Failed to load contradiction evidence paths',
			ANALYZE_ERROR_CODES.ANALYZE_TRAVERSAL_FAILED,
			{
				cause,
				context: { seedCount: seedIds.length },
			},
		);
	}
}

export async function computeEvidenceChainsForThesis(
	pool: pg.Pool,
	config: MulderConfig,
	thesis: string,
): Promise<EvidenceChainThesisComputation> {
	const normalizedThesis = normalizeThesis(thesis);
	const seedIds = await resolveThesisSeedIds(pool, normalizedThesis);

	if (seedIds.length === 0) {
		throw new AnalyzeError(
			`No thesis seeds resolved for "${normalizedThesis}"`,
			ANALYZE_ERROR_CODES.ANALYZE_THESIS_UNRESOLVED,
			{
				context: { thesis: normalizedThesis },
			},
		);
	}

	const [supportingChains, contradictionChains] = await Promise.all([
		loadSupportingPaths(
			pool,
			seedIds,
			config.retrieval.strategies.graph.max_hops,
			config.retrieval.strategies.graph.supernode_threshold,
		),
		loadContradictionPaths(pool, seedIds),
	]);

	return {
		thesis: normalizedThesis,
		seedIds,
		supportingChains: dedupeEvidenceChains(supportingChains.filter((chain) => chain.supports)),
		contradictionChains: dedupeEvidenceChains(contradictionChains.filter((chain) => !chain.supports)),
	};
}
