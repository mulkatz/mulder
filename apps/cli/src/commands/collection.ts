import type { CollectionType, CollectionVisibility, SensitivityLevel } from '@mulder/core';
import {
	addCollectionTags,
	closeAllPools,
	createCollection,
	findCollectionById,
	getWorkerPool,
	listCollections,
	loadConfig,
	removeCollectionTags,
	summarizeCollection,
	updateCollection,
} from '@mulder/core';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

interface CollectionCreateOptions {
	type?: CollectionType;
	archive?: string;
	description?: string;
	visibility?: CollectionVisibility;
	tag?: string[];
	json?: boolean;
}

interface CollectionListOptions {
	type?: CollectionType;
	visibility?: CollectionVisibility;
	tag?: string;
	json?: boolean;
}

interface CollectionJsonOption {
	json?: boolean;
}

interface CollectionTagOptions {
	add?: string[];
	remove?: string[];
	json?: boolean;
}

interface CollectionDefaultsOptions {
	sensitivity?: SensitivityLevel;
	language?: string;
	credibilityProfile?: string;
	json?: boolean;
}

function requirePool() {
	const config = loadConfig();
	if (!config.gcp?.cloud_sql) {
		printError('GCP configuration with cloud_sql is required for collection commands');
		process.exit(1);
		return null;
	}
	return getWorkerPool(config.gcp.cloud_sql);
}

function printCollectionLine(collection: {
	collectionId: string;
	name: string;
	type: string;
	visibility: string;
}): void {
	process.stdout.write(
		`${collection.collectionId}  ${collection.type.padEnd(14)}  ${collection.visibility.padEnd(7)}  ${collection.name}\n`,
	);
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function registerCollectionCommands(program: Command): void {
	const collection = program.command('collection').description('Collection management operations');

	collection
		.command('create')
		.description('Create a logical document collection')
		.requiredOption('--name <name>', 'Collection name')
		.option('--type <type>', 'Collection type', 'other')
		.option('--archive <archive-id>', 'Archive UUID for archive mirror collections')
		.option('--description <text>', 'Collection description')
		.option('--visibility <visibility>', 'Collection visibility', 'private')
		.option('--tag <tag>', 'Collection tag (repeatable)', collect, [])
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (options: CollectionCreateOptions & { name: string }) => {
				const pool = requirePool();
				if (!pool) return;
				try {
					const created = await createCollection(pool, {
						name: options.name,
						description: options.description ?? '',
						type: options.type ?? 'other',
						archiveId: options.archive ?? null,
						visibility: options.visibility ?? 'private',
						tags: options.tag ?? [],
						createdBy: 'cli',
					});
					if (options.json) {
						printJson(created);
						return;
					}
					printSuccess(`Collection created: ${created.collectionId}`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	collection
		.command('list')
		.description('List document collections')
		.option('--type <type>', 'Filter by collection type')
		.option('--visibility <visibility>', 'Filter by visibility')
		.option('--tag <tag>', 'Filter by tag')
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (options: CollectionListOptions) => {
				const pool = requirePool();
				if (!pool) return;
				try {
					const collections = await listCollections(pool, {
						type: options.type,
						visibility: options.visibility,
						tag: options.tag,
					});
					const summaries = await Promise.all(collections.map((item) => summarizeCollection(pool, item.collectionId)));
					const visible = summaries.filter((item): item is NonNullable<typeof item> => item !== null);
					if (options.json) {
						printJson(visible);
						return;
					}
					for (const item of visible) {
						printCollectionLine(item);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);

	collection
		.command('show')
		.description('Show collection details and derived statistics')
		.argument('<collection-id>', 'Collection UUID')
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (collectionId: string, options: CollectionJsonOption) => {
				const pool = requirePool();
				if (!pool) return;
				try {
					const summary = await summarizeCollection(pool, collectionId);
					if (!summary) {
						printError(`Collection not found: ${collectionId}`);
						process.exit(1);
						return;
					}
					if (options.json) {
						printJson(summary);
						return;
					}
					printCollectionLine(summary);
					process.stdout.write(`Documents: ${summary.documentCount}\n`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	collection
		.command('tag')
		.description('Add or remove collection tags')
		.argument('<collection-id>', 'Collection UUID')
		.option('--add <tag>', 'Tag to add (repeatable)', collect, [])
		.option('--remove <tag>', 'Tag to remove (repeatable)', collect, [])
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (collectionId: string, options: CollectionTagOptions) => {
				const pool = requirePool();
				if (!pool) return;
				try {
					let updated = await findCollectionById(pool, collectionId);
					if (!updated) {
						printError(`Collection not found: ${collectionId}`);
						process.exit(1);
						return;
					}
					if ((options.add ?? []).length > 0) {
						updated = await addCollectionTags(pool, collectionId, options.add ?? []);
					}
					if ((options.remove ?? []).length > 0) {
						updated = await removeCollectionTags(pool, collectionId, options.remove ?? []);
					}
					if (options.json) {
						printJson(updated);
						return;
					}
					printSuccess(`Collection tags updated: ${updated.tags.join(', ')}`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	collection
		.command('defaults')
		.description('Show or update collection ingest defaults')
		.argument('<collection-id>', 'Collection UUID')
		.option('--sensitivity <level>', 'Default sensitivity level')
		.option('--language <code>', 'Default language code')
		.option('--credibility-profile <id>', 'Default credibility profile UUID')
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (collectionId: string, options: CollectionDefaultsOptions) => {
				const pool = requirePool();
				if (!pool) return;
				try {
					const existing = await findCollectionById(pool, collectionId);
					if (!existing) {
						printError(`Collection not found: ${collectionId}`);
						process.exit(1);
						return;
					}
					const shouldUpdate =
						options.sensitivity !== undefined ||
						options.language !== undefined ||
						options.credibilityProfile !== undefined;
					const updated = shouldUpdate
						? await updateCollection(pool, collectionId, {
								defaults: {
									sensitivityLevel: options.sensitivity ?? existing.defaults.sensitivityLevel,
									defaultLanguage: options.language ?? existing.defaults.defaultLanguage,
									credibilityProfileId:
										options.credibilityProfile === undefined
											? existing.defaults.credibilityProfileId
											: options.credibilityProfile,
								},
							})
						: existing;
					if (options.json) {
						printJson(updated.defaults);
						return;
					}
					process.stdout.write(JSON.stringify(updated.defaults, null, 2));
					process.stdout.write('\n');
				} finally {
					await closeAllPools();
				}
			}),
		);
}
