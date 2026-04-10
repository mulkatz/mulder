/**
 * CLI command group: `mulder export`.
 *
 * Subcommands:
 * - `graph` — Export knowledge graph (nodes + edges) in json/csv/graphml/cypher
 * - `stories` — Export stories with linked entities in json/csv/markdown
 * - `evidence` — Export evidence report (corroboration, contradictions, duplicates) in json/csv/markdown
 *
 * All data output goes to stdout (pipeable), status messages to stderr.
 * Thin wrapper: parses arguments, loads config, creates pool,
 * calls repository functions, formats output. No business logic here.
 *
 * @see docs/specs/53_export_commands.spec.md
 * @see docs/functional-spec.md §1 (export cmd), §5.3 (sparse graph degradation)
 */

import type { EdgeType, EntityEdge, StoryFilter, StoryStatus } from '@mulder/core';
import {
	closeAllPools,
	countEntities,
	countSources,
	findAliasesByEntityId,
	findAllEdges,
	findAllEntities,
	findAllStories,
	findEntitiesByStoryId,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import type { DataReliability, EvidenceEdge, EvidenceEntity, EvidenceExportData } from '../lib/formatters/evidence.js';
import { formatEvidenceCsv, formatEvidenceJson, formatEvidenceMarkdown } from '../lib/formatters/evidence.js';
import type { GraphExportEdge, GraphExportNode } from '../lib/formatters/graph.js';
import { formatGraphCsv, formatGraphCypher, formatGraphJson, formatGraphMl } from '../lib/formatters/graph.js';
import type { StoryExport } from '../lib/formatters/stories.js';
import { formatStoriesCsv, formatStoriesJson, formatStoriesMarkdown } from '../lib/formatters/stories.js';
import { printError } from '../lib/output.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

type GraphFormat = 'json' | 'csv' | 'graphml' | 'cypher';
type StoryFormat = 'json' | 'csv' | 'markdown';
type EvidenceFormat = 'json' | 'csv' | 'markdown';

interface GraphCommandOptions {
	format: string;
	filter?: string[];
}

interface StoriesCommandOptions {
	format: string;
	source?: string;
	status?: string;
}

interface EvidenceCommandOptions {
	format: string;
}

interface ParsedFilters {
	type?: string;
	edge?: string;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const GRAPH_FORMATS: ReadonlySet<string> = new Set(['json', 'csv', 'graphml', 'cypher']);
const STORY_FORMATS: ReadonlySet<string> = new Set(['json', 'csv', 'markdown']);
const EVIDENCE_FORMATS: ReadonlySet<string> = new Set(['json', 'csv', 'markdown']);

/** Valid edge type values for filter validation. */
const VALID_EDGE_TYPES: ReadonlySet<string> = new Set([
	'RELATIONSHIP',
	'DUPLICATE_OF',
	'POTENTIAL_CONTRADICTION',
	'CONFIRMED_CONTRADICTION',
	'DISMISSED_CONTRADICTION',
]);

/** Type guard for GraphFormat. */
function isGraphFormat(value: string): value is GraphFormat {
	return GRAPH_FORMATS.has(value);
}

/** Type guard for StoryFormat. */
function isStoryFormat(value: string): value is StoryFormat {
	return STORY_FORMATS.has(value);
}

/** Type guard for EvidenceFormat. */
function isEvidenceFormat(value: string): value is EvidenceFormat {
	return EVIDENCE_FORMATS.has(value);
}

/** Type guard for EdgeType. */
function isEdgeType(value: string): value is EdgeType {
	return VALID_EDGE_TYPES.has(value);
}

/** Valid story status values. */
const VALID_STORY_STATUSES = new Map<string, StoryStatus>([
	['segmented', 'segmented'],
	['enriched', 'enriched'],
	['embedded', 'embedded'],
	['graphed', 'graphed'],
	['analyzed', 'analyzed'],
]);

/** Validates a story status string and returns the typed value. Exits with error if invalid. */
function validateStoryStatus(value: string): StoryStatus {
	const status = VALID_STORY_STATUSES.get(value);
	if (!status) {
		printError(`Invalid story status: "${value}". Valid statuses: segmented, enriched, embedded, graphed, analyzed`);
		process.exit(1);
	}
	return status;
}

/**
 * Parses `--filter key=value` pairs into a structured object.
 * Supports `type=<entity-type>` and `edge=<edge-type>`.
 */
function parseFilters(filters: string[] | undefined): ParsedFilters {
	const result: ParsedFilters = {};
	if (!filters) {
		return result;
	}

	for (const filter of filters) {
		const eqIndex = filter.indexOf('=');
		if (eqIndex === -1) {
			printError(`Invalid filter format: "${filter}". Expected key=value (e.g., type=person)`);
			process.exit(1);
		}
		const key = filter.slice(0, eqIndex);
		const value = filter.slice(eqIndex + 1);

		if (key === 'type') {
			result.type = value;
		} else if (key === 'edge') {
			result.edge = value;
		} else {
			printError(`Unknown filter key: "${key}". Supported keys: type, edge`);
			process.exit(1);
		}
	}

	return result;
}

/**
 * Maps an EntityEdge from the repository to an EvidenceEdge for export.
 */
function toEvidenceEdge(edge: EntityEdge): EvidenceEdge {
	return {
		id: edge.id,
		sourceEntityId: edge.sourceEntityId,
		targetEntityId: edge.targetEntityId,
		relationship: edge.relationship,
		edgeType: edge.edgeType,
		confidence: edge.confidence,
		storyId: edge.storyId,
		attributes: edge.attributes,
	};
}

/**
 * Computes data reliability level from entity count vs threshold.
 *
 * Based on §5.3 sparse graph degradation — corroboration_meaningful
 * threshold determines when scores are reliable.
 */
function computeDataReliability(entityCount: number, threshold: number): DataReliability {
	const ratio = entityCount / threshold;
	if (ratio < 0.25) return 'insufficient';
	if (ratio < 0.5) return 'low';
	if (ratio < 1.0) return 'moderate';
	return 'high';
}

// ────────────────────────────────────────────────────────────
// Command registration
// ────────────────────────────────────────────────────────────

/**
 * Registers the `export` command group on the given Commander program.
 *
 * Usage:
 * ```
 * mulder export graph    --format json|csv|graphml|cypher [--filter type=<type>] [--filter edge=<edge-type>]
 * mulder export stories  --format json|csv|markdown [--source <id>] [--status <status>]
 * mulder export evidence --format json|csv|markdown
 * ```
 */
export function registerExportCommands(program: Command): void {
	const exportCmd = program.command('export').description('Export knowledge graph data, stories, and evidence reports');

	// ── export graph ──────────────────────────────────────────

	exportCmd
		.command('graph')
		.description('Export knowledge graph (nodes + edges)')
		.option('--format <format>', 'output format: json, csv, graphml, cypher', 'json')
		.option('--filter <filter...>', 'filter by type=<type> or edge=<edge-type>')
		.action(
			withErrorHandler(async (options: GraphCommandOptions) => {
				if (!isGraphFormat(options.format)) {
					printError(`Invalid format: "${options.format}". Valid formats: json, csv, graphml, cypher`);
					process.exit(1);
					return;
				}

				const format = options.format;
				const filters = parseFilters(options.filter);
				const config = loadConfig();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for export commands');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					// Fetch entities — active only (exclude merged)
					const entityFilter = {
						type: filters.type,
						limit: 100000,
					};
					const allEntities = await findAllEntities(pool, entityFilter);
					const entities = allEntities.filter((e) => e.taxonomyStatus !== 'merged');

					// Build a set of entity IDs for edge filtering
					const entityIds = new Set(entities.map((e) => e.id));

					// Fetch edges
					const edgeFilter: { edgeType?: EdgeType; limit: number } = {
						limit: 100000,
					};
					if (filters.edge) {
						if (!isEdgeType(filters.edge)) {
							printError(
								`Invalid edge type: "${filters.edge}". Valid types: RELATIONSHIP, DUPLICATE_OF, POTENTIAL_CONTRADICTION, CONFIRMED_CONTRADICTION, DISMISSED_CONTRADICTION`,
							);
							process.exit(1);
							return;
						}
						edgeFilter.edgeType = filters.edge;
					}
					const allEdges = await findAllEdges(pool, edgeFilter);

					// If type filter is active, only include edges referencing filtered entities
					const filteredEdges = filters.type
						? allEdges.filter((e) => entityIds.has(e.sourceEntityId) && entityIds.has(e.targetEntityId))
						: allEdges;

					// Fetch aliases for all entities
					const aliasMap = new Map<string, string[]>();
					for (const entity of entities) {
						const aliases = await findAliasesByEntityId(pool, entity.id);
						aliasMap.set(
							entity.id,
							aliases.map((a) => a.alias),
						);
					}

					// Build export nodes
					const nodes: GraphExportNode[] = entities.map((entity) => ({
						id: entity.id,
						name: entity.name,
						type: entity.type,
						canonicalId: entity.canonicalId,
						corroborationScore: entity.corroborationScore,
						sourceCount: entity.sourceCount,
						taxonomyStatus: entity.taxonomyStatus,
						aliases: aliasMap.get(entity.id) ?? [],
						attributes: entity.attributes,
					}));

					// Build export edges
					const edges: GraphExportEdge[] = filteredEdges.map((edge) => ({
						id: edge.id,
						sourceEntityId: edge.sourceEntityId,
						targetEntityId: edge.targetEntityId,
						relationship: edge.relationship,
						edgeType: edge.edgeType,
						confidence: edge.confidence,
						storyId: edge.storyId,
						attributes: edge.attributes,
					}));

					if (nodes.length === 0 && edges.length === 0) {
						process.stderr.write(`${chalk.yellow('!')} No data to export — database is empty\n`);
					}

					// Format and output
					let output: string;
					switch (format) {
						case 'json':
							output = formatGraphJson(nodes, edges);
							break;
						case 'csv':
							output = formatGraphCsv(nodes, edges);
							break;
						case 'graphml':
							output = formatGraphMl(nodes, edges);
							break;
						case 'cypher':
							output = formatGraphCypher(nodes, edges);
							break;
					}

					process.stdout.write(`${output}\n`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── export stories ───────────────────────────────────────

	exportCmd
		.command('stories')
		.description('Export stories with linked entities')
		.option('--format <format>', 'output format: json, csv, markdown', 'json')
		.option('--source <id>', 'filter by source ID')
		.option('--status <status>', 'filter by story status')
		.action(
			withErrorHandler(async (options: StoriesCommandOptions) => {
				if (!isStoryFormat(options.format)) {
					printError(`Invalid format: "${options.format}". Valid formats: json, csv, markdown`);
					process.exit(1);
					return;
				}

				const format = options.format;
				const config = loadConfig();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for export commands');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					// Fetch stories with optional filters
					const storyFilter: StoryFilter = {
						limit: 100000,
						sourceId: options.source,
						status: options.status ? validateStoryStatus(options.status) : undefined,
					};

					const stories = await findAllStories(pool, storyFilter);

					// Build export data with linked entities
					const storyExports: StoryExport[] = [];
					for (const story of stories) {
						const linkedEntities = await findEntitiesByStoryId(pool, story.id);
						storyExports.push({
							id: story.id,
							sourceId: story.sourceId,
							title: story.title,
							subtitle: story.subtitle,
							language: story.language,
							category: story.category,
							pageStart: story.pageStart,
							pageEnd: story.pageEnd,
							status: story.status,
							chunkCount: story.chunkCount,
							extractionConfidence: story.extractionConfidence,
							entities: linkedEntities.map((e) => ({
								id: e.id,
								name: e.name,
								type: e.type,
								mentionCount: e.mentionCount,
							})),
						});
					}

					if (storyExports.length === 0) {
						process.stderr.write(`${chalk.yellow('!')} No stories to export — database is empty\n`);
					}

					// Format and output
					let output: string;
					switch (format) {
						case 'json':
							output = formatStoriesJson(storyExports);
							break;
						case 'csv':
							output = formatStoriesCsv(storyExports);
							break;
						case 'markdown':
							output = formatStoriesMarkdown(storyExports);
							break;
					}

					process.stdout.write(`${output}\n`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── export evidence ──────────────────────────────────────

	exportCmd
		.command('evidence')
		.description('Export evidence report (corroboration scores, contradictions, duplicates)')
		.option('--format <format>', 'output format: json, csv, markdown', 'json')
		.action(
			withErrorHandler(async (options: EvidenceCommandOptions) => {
				if (!isEvidenceFormat(options.format)) {
					printError(`Invalid format: "${options.format}". Valid formats: json, csv, markdown`);
					process.exit(1);
					return;
				}

				const format = options.format;
				const config = loadConfig();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for export commands');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					// Fetch all entities to compute totals
					const totalEntityCount = await countEntities(pool);
					const totalSourceCount = await countSources(pool);

					// Fetch entities with corroboration scores
					const allEntities = await findAllEntities(pool, { limit: 100000 });
					const scoredEntities = allEntities.filter(
						(e) => e.corroborationScore !== null && e.taxonomyStatus !== 'merged',
					);

					const evidenceEntities: EvidenceEntity[] = scoredEntities.map((e) => ({
						id: e.id,
						name: e.name,
						type: e.type,
						corroborationScore: e.corroborationScore ?? 0,
						sourceCount: e.sourceCount,
					}));

					// Fetch contradiction edges (all types) and duplicates
					const [potentialContradictions, confirmedContradictions, dismissedContradictions, duplicates] =
						await Promise.all([
							findAllEdges(pool, { edgeType: 'POTENTIAL_CONTRADICTION', limit: 100000 }),
							findAllEdges(pool, { edgeType: 'CONFIRMED_CONTRADICTION', limit: 100000 }),
							findAllEdges(pool, { edgeType: 'DISMISSED_CONTRADICTION', limit: 100000 }),
							findAllEdges(pool, { edgeType: 'DUPLICATE_OF', limit: 100000 }),
						]);

					const allContradictions = [
						...potentialContradictions,
						...confirmedContradictions,
						...dismissedContradictions,
					];

					// Compute summary
					const avgCorroboration =
						evidenceEntities.length > 0
							? evidenceEntities.reduce((sum, e) => sum + e.corroborationScore, 0) / evidenceEntities.length
							: 0;

					const corroborationThreshold = config.thresholds?.corroboration_meaningful ?? 50;
					const dataReliability = computeDataReliability(totalSourceCount, corroborationThreshold);

					const exportData: EvidenceExportData = {
						entities: evidenceEntities,
						contradictions: allContradictions.map(toEvidenceEdge),
						duplicates: duplicates.map(toEvidenceEdge),
						summary: {
							totalEntities: totalEntityCount,
							scoredEntities: evidenceEntities.length,
							avgCorroboration,
							contradictionCount: allContradictions.length,
							duplicateCount: duplicates.length,
							dataReliability,
						},
					};

					if (evidenceEntities.length === 0 && allContradictions.length === 0 && duplicates.length === 0) {
						process.stderr.write(`${chalk.yellow('!')} No evidence data to export — database is empty\n`);
					}

					if (dataReliability === 'insufficient' || dataReliability === 'low') {
						process.stderr.write(
							`${chalk.yellow('!')} Data reliability: ${dataReliability} (${totalSourceCount} sources, threshold: ${corroborationThreshold})\n`,
						);
					}

					// Format and output
					let output: string;
					switch (format) {
						case 'json':
							output = formatEvidenceJson(exportData);
							break;
						case 'csv':
							output = formatEvidenceCsv(exportData);
							break;
						case 'markdown':
							output = formatEvidenceMarkdown(exportData);
							break;
					}

					process.stdout.write(`${output}\n`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
