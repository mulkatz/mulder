/**
 * CLI command group: `mulder entity`.
 *
 * Subcommands:
 * - `list` — List entities with optional type/search filters
 * - `show` — Show entity details with aliases, edges, stories, and merged entities
 * - `merge` — Merge two entities (source into target)
 * - `aliases` — List, add, or remove entity aliases
 *
 * Thin wrapper: parses arguments, loads config, creates pool,
 * calls repository functions, formats output. No business logic here.
 *
 * @see docs/specs/51_entity_management_cli.spec.md
 * @see docs/functional-spec.md §1 (entity cmd)
 */

import type {
	CorroborationPresentationContext,
	CorroborationPresentationStatus,
	Entity,
	EntityAlias,
	EntityEdge,
	MergeEntitiesResult,
} from '@mulder/core';
import {
	closeAllPools,
	countEntities,
	countProcessedSources,
	createEntityAlias,
	deleteEntityAlias,
	findAliasesByEntityId,
	findAllEntities,
	findEdgesByEntityId,
	findEntitiesByCanonicalId,
	findEntityById,
	findStoriesByEntityId,
	getWorkerPool,
	loadConfig,
	mergeEntities,
	presentCorroborationScore,
} from '@mulder/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

interface ListCommandOptions {
	type?: string;
	search?: string;
	json?: boolean;
}

interface ShowCommandOptions {
	json?: boolean;
}

interface MergeCommandOptions {
	json?: boolean;
}

interface AliasCommandOptions {
	add?: string;
	remove?: string;
	json?: boolean;
}

type PresentedEntity = Entity & {
	corroborationScore: number | null;
	corroborationStatus: CorroborationPresentationStatus;
};

// ────────────────────────────────────────────────────────────
// Output formatters
// ────────────────────────────────────────────────────────────

/** Truncates a UUID to its first 8 characters for display. */
function shortId(id: string): string {
	return id.slice(0, 8);
}

function presentEntity(entity: Entity, context: CorroborationPresentationContext): PresentedEntity {
	const corroboration = presentCorroborationScore(entity.corroborationScore, context);
	return {
		...entity,
		corroborationScore: corroboration.score,
		corroborationStatus: corroboration.status,
	};
}

function formatCorroboration(entity: PresentedEntity): string {
	if (entity.corroborationStatus === 'insufficient_data') {
		return 'insufficient_data';
	}
	return entity.corroborationScore !== null ? String(entity.corroborationScore) : '-';
}

function printEntityTable(entities: PresentedEntity[], total: number): void {
	const header = [
		'ID'.padEnd(10),
		'Name'.padEnd(30),
		'Type'.padEnd(15),
		'Status'.padEnd(10),
		'Sources'.padEnd(8),
		'Corroboration',
	].join('  ');

	process.stdout.write(`${chalk.bold(header)}\n`);
	process.stdout.write(`${'─'.repeat(header.length)}\n`);

	for (const entity of entities) {
		const line = [
			shortId(entity.id).padEnd(10),
			entity.name.slice(0, 30).padEnd(30),
			entity.type.padEnd(15),
			entity.taxonomyStatus.padEnd(10),
			String(entity.sourceCount).padEnd(8),
			formatCorroboration(entity),
		].join('  ');
		process.stdout.write(`${line}\n`);
	}

	process.stderr.write(`\nShowing ${entities.length} of ${total} entities\n`);
}

function printEntityDetails(
	entity: PresentedEntity,
	aliases: EntityAlias[],
	edges: EntityEdge[],
	stories: Array<{ id: string; title: string | null }>,
	mergedEntities: Entity[],
): void {
	process.stdout.write(`\n${chalk.bold('Entity Details')}\n`);
	process.stdout.write(`${'─'.repeat(40)}\n`);
	process.stdout.write(`  ID:             ${entity.id}\n`);
	process.stdout.write(`  Name:           ${entity.name}\n`);
	process.stdout.write(`  Type:           ${entity.type}\n`);
	process.stdout.write(`  Status:         ${entity.taxonomyStatus}\n`);
	process.stdout.write(`  Canonical ID:   ${entity.canonicalId ?? '-'}\n`);
	process.stdout.write(`  Taxonomy ID:    ${entity.taxonomyId ?? '-'}\n`);
	process.stdout.write(`  Source Count:    ${entity.sourceCount}\n`);
	process.stdout.write(`  Corroboration:  ${formatCorroboration(entity)}\n`);
	process.stdout.write(`  Created:        ${entity.createdAt.toISOString()}\n`);
	process.stdout.write(`  Updated:        ${entity.updatedAt.toISOString()}\n`);

	if (Object.keys(entity.attributes).length > 0) {
		process.stdout.write(`\n${chalk.bold('Attributes')}\n`);
		for (const [key, value] of Object.entries(entity.attributes)) {
			process.stdout.write(`  ${key}: ${JSON.stringify(value)}\n`);
		}
	}

	if (aliases.length > 0) {
		process.stdout.write(`\n${chalk.bold('Aliases')} (${aliases.length})\n`);
		for (const alias of aliases) {
			process.stdout.write(`  ${shortId(alias.id)}  ${alias.alias}  [${alias.source ?? 'unknown'}]\n`);
		}
	}

	if (edges.length > 0) {
		process.stdout.write(`\n${chalk.bold('Relationships')} (${edges.length})\n`);
		for (const edge of edges) {
			const direction = edge.sourceEntityId === entity.id ? '->' : '<-';
			const otherId = edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
			process.stdout.write(`  ${direction} ${shortId(otherId)}  ${edge.relationship}  [${edge.edgeType}]\n`);
		}
	}

	if (stories.length > 0) {
		process.stdout.write(`\n${chalk.bold('Stories')} (${stories.length})\n`);
		for (const story of stories) {
			process.stdout.write(`  ${shortId(story.id)}  ${story.title ?? '(untitled)'}\n`);
		}
	}

	if (mergedEntities.length > 0) {
		process.stdout.write(`\n${chalk.bold('Merged Entities')} (${mergedEntities.length})\n`);
		for (const merged of mergedEntities) {
			process.stdout.write(`  ${shortId(merged.id)}  ${merged.name}\n`);
		}
	}

	process.stdout.write('\n');
}

function printMergeResultOutput(result: MergeEntitiesResult): void {
	process.stdout.write(`\n${chalk.bold('Merge Result')}\n`);
	process.stdout.write(`${'─'.repeat(40)}\n`);
	process.stdout.write(`  Target:            ${result.target.name} (${shortId(result.target.id)})\n`);
	process.stdout.write(`  Merged:            ${result.merged.name} (${shortId(result.merged.id)})\n`);
	process.stdout.write(`  Edges reassigned:  ${result.edgesReassigned}\n`);
	process.stdout.write(`  Stories reassigned: ${result.storiesReassigned}\n`);
	process.stdout.write(`  Aliases copied:    ${result.aliasesCopied}\n`);
	process.stdout.write('\n');
}

function printAliasTable(aliases: EntityAlias[]): void {
	const header = ['ID'.padEnd(10), 'Alias'.padEnd(30), 'Source'].join('  ');

	process.stdout.write(`${chalk.bold(header)}\n`);
	process.stdout.write(`${'─'.repeat(header.length)}\n`);

	for (const alias of aliases) {
		const line = [shortId(alias.id).padEnd(10), alias.alias.slice(0, 30).padEnd(30), alias.source ?? 'unknown'].join(
			'  ',
		);
		process.stdout.write(`${line}\n`);
	}
}

// ────────────────────────────────────────────────────────────
// Command registration
// ────────────────────────────────────────────────────────────

/**
 * Registers the `entity` command group on the given Commander program.
 *
 * Usage:
 * ```
 * mulder entity list [--type <type>] [--search <q>] [--json]
 * mulder entity show <entity-id> [--json]
 * mulder entity merge <id1> <id2> [--json]
 * mulder entity aliases <entity-id> [--add <name>] [--remove <alias-id>] [--json]
 * ```
 */
export function registerEntityCommands(program: Command): void {
	const entity = program
		.command('entity')
		.description('Entity management — list, inspect, merge, and manage entity aliases');

	// ── list ──────────────────────────────────────────────────

	entity
		.command('list')
		.description('List entities with optional filters')
		.option('--type <type>', 'filter by entity type')
		.option('--search <q>', 'search by name (case-insensitive substring)')
		.option('--json', 'JSON output format')
		.action(
			withErrorHandler(async (options: ListCommandOptions) => {
				const config = loadConfig();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for entity commands');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const filter = {
						type: options.type,
						search: options.search,
						limit: 100,
					};

					const [entities, total, processedSourceCount] = await Promise.all([
						findAllEntities(pool, filter),
						countEntities(pool, { type: options.type, search: options.search }),
						countProcessedSources(pool),
					]);
					const corroborationContext = {
						corpusSize: processedSourceCount,
						threshold: config.thresholds.corroboration_meaningful,
					};
					const presentedEntities = entities.map((entity) => presentEntity(entity, corroborationContext));

					if (options.json) {
						printJson(presentedEntities);
						return;
					}

					printEntityTable(presentedEntities, total);
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── show ──────────────────────────────────────────────────

	entity
		.command('show')
		.description('Show detailed entity information')
		.argument('<entity-id>', 'entity UUID')
		.option('--json', 'JSON output format')
		.action(
			withErrorHandler(async (entityId: string, options: ShowCommandOptions) => {
				const config = loadConfig();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for entity commands');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const entityResult = await findEntityById(pool, entityId);
					if (!entityResult) {
						printError(`Entity not found: ${entityId}`);
						process.exit(1);
						return;
					}

					const [aliases, edges, stories, mergedEntities, processedSourceCount] = await Promise.all([
						findAliasesByEntityId(pool, entityId),
						findEdgesByEntityId(pool, entityId),
						findStoriesByEntityId(pool, entityId),
						findEntitiesByCanonicalId(pool, entityId),
						countProcessedSources(pool),
					]);
					const corroborationContext = {
						corpusSize: processedSourceCount,
						threshold: config.thresholds.corroboration_meaningful,
					};
					const presentedEntity = presentEntity(entityResult, corroborationContext);
					const presentedMergedEntities = mergedEntities.map((merged) => presentEntity(merged, corroborationContext));

					if (options.json) {
						printJson({
							entity: presentedEntity,
							aliases,
							edges,
							stories,
							mergedEntities: presentedMergedEntities,
						});
						return;
					}

					printEntityDetails(
						presentedEntity,
						aliases,
						edges,
						stories.map((s) => ({ id: s.id, title: s.title })),
						presentedMergedEntities,
					);
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── merge ─────────────────────────────────────────────────

	entity
		.command('merge')
		.description('Merge entity id2 into entity id1 (id1 survives)')
		.argument('<id1>', 'target entity UUID (survives)')
		.argument('<id2>', 'source entity UUID (gets merged)')
		.option('--json', 'JSON output format')
		.action(
			withErrorHandler(async (id1: string, id2: string, options: MergeCommandOptions) => {
				const config = loadConfig();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for entity commands');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const result = await mergeEntities(pool, id1, id2);

					if (options.json) {
						printJson(result);
						return;
					}

					printMergeResultOutput(result);
					printSuccess(`Merged "${result.merged.name}" into "${result.target.name}"`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── aliases ───────────────────────────────────────────────

	entity
		.command('aliases')
		.description('List, add, or remove entity aliases')
		.argument('<entity-id>', 'entity UUID')
		.option('--add <name>', 'add a new alias')
		.option('--remove <alias-id>', 'remove an alias by its UUID')
		.option('--json', 'JSON output format')
		.action(
			withErrorHandler(async (entityId: string, options: AliasCommandOptions) => {
				const config = loadConfig();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for entity commands');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					// Verify entity exists
					const entityResult = await findEntityById(pool, entityId);
					if (!entityResult) {
						printError(`Entity not found: ${entityId}`);
						process.exit(1);
						return;
					}

					// Add alias
					if (options.add) {
						const alias = await createEntityAlias(pool, {
							entityId,
							alias: options.add,
							source: 'manual',
						});
						if (options.json) {
							printJson(alias);
						} else {
							printSuccess(`Added alias "${alias.alias}" to entity "${entityResult.name}"`);
						}
					}

					// Remove alias
					if (options.remove) {
						const deleted = await deleteEntityAlias(pool, options.remove);
						if (!deleted) {
							printError(`Alias not found: ${options.remove}`);
							process.exit(1);
							return;
						}
						if (!options.json) {
							printSuccess(`Removed alias ${options.remove}`);
						}
					}

					// List aliases (always, after any add/remove)
					const aliases = await findAliasesByEntityId(pool, entityId);

					if (options.json) {
						// Only print JSON list if we didn't already print an add result
						if (!options.add) {
							printJson(aliases);
						}
						return;
					}

					if (!options.add && !options.remove) {
						printAliasTable(aliases);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
