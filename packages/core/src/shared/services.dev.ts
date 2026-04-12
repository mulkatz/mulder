/**
 * Dev-mode service implementations backed by the `fixtures/` directory.
 *
 * These classes implement the service interfaces from `services.ts` and
 * return pre-recorded GCP API responses for local development and testing.
 * No GCP calls, no cost, deterministic results.
 *
 * @see docs/specs/11_service_abstraction.spec.md §4.2
 * @see docs/functional-spec.md §4.5, §9.1
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MulderConfig } from '../config/types.js';
import type { Logger } from './logger.js';
import type {
	DocumentAiResult,
	DocumentAiService,
	EmbeddingResult,
	EmbeddingService,
	FirestoreService,
	GroundedGenerateOptions,
	GroundedGenerateResult,
	LlmService,
	Services,
	StorageListResult,
	StorageService,
	StructuredGenerateOptions,
	TextGenerateOptions,
} from './services.js';

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Parses a JSON string and returns it typed as `Record<string, unknown>`.
 * Returns an empty object if the parsed value is not a plain object.
 */
function parseJsonRecord(raw: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(raw);
	if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
		// Re-construct via Object.entries to get a proper Record<string, unknown>
		return Object.fromEntries(Object.entries(parsed));
	}
	return {};
}

/**
 * Returns an empty object typed for generic dev-mode stub responses.
 * Uses JSON.parse to produce the correct type without explicit assertions
 * (external API mock pattern).
 */
function emptyStubResponse<T>(): T {
	return JSON.parse('{}');
}

/**
 * Safely reads a nested property from an unknown value.
 * Returns `undefined` if the path doesn't exist or any intermediate is not an object.
 */
function getNestedProperty(obj: unknown, ...keys: string[]): unknown {
	let current: unknown = obj;
	for (const key of keys) {
		if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}
		current = Object.getOwnPropertyDescriptor(current, key)?.value;
	}
	return current;
}

/**
 * Extracts enum values from a JSON Schema's array items.
 *
 * Navigates: `schema.properties[arrayProp].items.properties[fieldProp].enum`
 * Returns the enum values as a string array, or an empty array if the path
 * doesn't exist or is not an array.
 */
function extractEnumValues(schema: Record<string, unknown>, arrayProp: string, fieldProp: string): string[] {
	const enumValues = getNestedProperty(schema, 'properties', arrayProp, 'items', 'properties', fieldProp, 'enum');
	if (!Array.isArray(enumValues)) return [];
	return enumValues.filter((v): v is string => typeof v === 'string');
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'entity'
	);
}

// ────────────────────────────────────────────────────────────
// Dev Storage Service
// ────────────────────────────────────────────────────────────

/**
 * Dev storage with write/read path separation.
 *
 * - **Writes** always go to `storagePath` (`.local/storage/`) — runtime data
 *   that is gitignored and never pollutes the checked-in fixtures directory.
 * - **Reads** try `storagePath` first, then fall back to `fixturesPath`
 *   (`fixtures/`) for pre-recorded test data.
 */
class DevStorageService implements StorageService {
	private readonly storagePath: string;
	private readonly fixturesPath: string;
	private readonly logger: Logger;

	constructor(storagePath: string, fixturesPath: string, logger: Logger) {
		this.storagePath = storagePath;
		this.fixturesPath = fixturesPath;
		this.logger = logger;
	}

	/** Resolve a read path: prefer storagePath, fall back to fixturesPath. */
	private resolvePath(bucketPath: string): string {
		const primary = join(this.storagePath, bucketPath);
		if (existsSync(primary)) return primary;
		const fallback = join(this.fixturesPath, bucketPath);
		if (existsSync(fallback)) return fallback;
		return primary; // Return primary even if missing — let caller handle the error
	}

	async upload(bucketPath: string, content: Buffer | string, _contentType?: string): Promise<void> {
		const fullPath = join(this.storagePath, bucketPath);
		const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
		mkdirSync(dir, { recursive: true });
		writeFileSync(fullPath, content);
		this.logger.debug({ bucketPath }, 'DevStorageService: uploaded');
	}

	async download(bucketPath: string): Promise<Buffer> {
		const fullPath = this.resolvePath(bucketPath);
		this.logger.debug({ bucketPath, fullPath }, 'DevStorageService: downloading');
		return readFileSync(fullPath);
	}

	async exists(bucketPath: string): Promise<boolean> {
		const primary = join(this.storagePath, bucketPath);
		const fallback = join(this.fixturesPath, bucketPath);
		const result = existsSync(primary) || existsSync(fallback);
		this.logger.debug({ bucketPath, exists: result }, 'DevStorageService: checking existence');
		return result;
	}

	async list(prefix: string): Promise<StorageListResult> {
		// Merge results from both storagePath and fixturesPath
		const allPaths = new Set<string>();
		for (const basePath of [this.storagePath, this.fixturesPath]) {
			const fullPath = join(basePath, prefix);
			if (!existsSync(fullPath)) continue;
			const entries = readdirSync(fullPath, { recursive: true, withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const entryDir = entry.parentPath;
				const relativePath = entryDir.replace(basePath, '').replace(/^\//, '');
				allPaths.add(`${relativePath}/${entry.name}`);
			}
		}
		const paths = [...allPaths].sort();
		this.logger.debug({ prefix, count: paths.length }, 'DevStorageService: listing');
		return { paths };
	}

	async delete(bucketPath: string): Promise<void> {
		// Only delete from storagePath — never touch fixtures
		const fullPath = join(this.storagePath, bucketPath);
		if (existsSync(fullPath)) {
			unlinkSync(fullPath);
		}
		this.logger.debug({ bucketPath }, 'DevStorageService: deleted');
	}
}

// ────────────────────────────────────────────────────────────
// Dev Document AI Service
// ────────────────────────────────────────────────────────────

/**
 * Returns pre-recorded Document AI JSON from `fixtures/extracted/`.
 */
class DevDocumentAiService implements DocumentAiService {
	private readonly basePath: string;
	private readonly logger: Logger;

	constructor(fixturesPath: string, logger: Logger) {
		this.basePath = join(fixturesPath, 'extracted');
		this.logger = logger;
	}

	async processDocument(_pdfContent: Buffer, sourceId: string): Promise<DocumentAiResult> {
		this.logger.debug({ sourceId }, 'DevDocumentAiService: returning fixture data');

		// Look for a layout.json in the source's fixture directory
		const layoutPath = join(this.basePath, sourceId, 'layout.json');
		if (existsSync(layoutPath)) {
			const document = parseJsonRecord(readFileSync(layoutPath, 'utf-8'));

			// Load page images if they exist
			const pagesDir = join(this.basePath, sourceId, 'pages');
			const pageImages: Buffer[] = [];
			if (existsSync(pagesDir)) {
				const pageFiles = readdirSync(pagesDir)
					.filter((f) => f.endsWith('.png'))
					.sort();
				for (const pageFile of pageFiles) {
					pageImages.push(readFileSync(join(pagesDir, pageFile)));
				}
			}

			return { document, pageImages };
		}

		// Return empty result if no fixture exists
		this.logger.debug({ sourceId }, 'DevDocumentAiService: no fixture found, returning empty');
		return { document: {}, pageImages: [] };
	}
}

// ────────────────────────────────────────────────────────────
// Dev LLM Service
// ────────────────────────────────────────────────────────────

/**
 * Returns pre-recorded Gemini responses from fixtures.
 * For structured output, looks in `fixtures/entities/` and `fixtures/segments/`.
 *
 * Detects known schemas (segmentation, entity extraction) by inspecting the
 * JSON Schema properties and returns appropriate fixture data.
 */
class DevLlmService implements LlmService {
	private readonly logger: Logger;

	constructor(_fixturesPath: string, logger: Logger) {
		this.logger = logger;
	}

	async generateStructured<T = unknown>(options: StructuredGenerateOptions): Promise<T> {
		const properties = options.schema.properties;
		const hasProperty = (name: string): boolean =>
			properties !== null &&
			properties !== undefined &&
			typeof properties === 'object' &&
			!Array.isArray(properties) &&
			name in properties;

		let result: T;

		// Detect segmentation schema by checking for a 'stories' property in the JSON Schema
		if (hasProperty('stories')) {
			this.logger.debug('DevLlmService: generateStructured — returning segmentation fixture');
			result = JSON.parse(
				JSON.stringify({
					stories: [
						{
							title: 'Dev Mode Test Story',
							subtitle: null,
							language: 'en',
							category: 'article',
							page_start: 1,
							page_end: 1,
							date_references: [],
							geographic_references: [],
							confidence: 0.95,
							content_markdown: '# Dev Mode Test Story\n\nThis is a test story generated by the dev LLM service.',
						},
					],
				}),
			);
		}
		// Detect entity extraction schema by checking for 'entities' property
		else if (hasProperty('entities')) {
			this.logger.debug('DevLlmService: generateStructured — returning entity extraction fixture');

			// Extract valid entity types and relationship types from the JSON Schema
			const entityTypes = extractEnumValues(options.schema, 'entities', 'type');
			const relationshipTypes = extractEnumValues(options.schema, 'relationships', 'relationship_type');

			// Build entities using valid types from the schema
			const entities: Array<Record<string, unknown>> = [];
			if (entityTypes.includes('person')) {
				entities.push({
					name: 'Dev Test Person',
					type: 'person',
					confidence: 0.9,
					attributes: { role: 'researcher' },
					mentions: ['Dev Test Person'],
				});
			}
			if (entityTypes.includes('location')) {
				entities.push({
					name: 'Dev Test Location',
					type: 'location',
					confidence: 0.85,
					attributes: { region: 'Europe' },
					mentions: ['Dev Test Location'],
				});
			}
			// Fallback: if neither person nor location is in schema, use the first available type
			if (entities.length === 0 && entityTypes.length > 0) {
				entities.push({
					name: 'Dev Test Entity',
					type: entityTypes[0],
					confidence: 0.9,
					attributes: {},
					mentions: ['Dev Test Entity'],
				});
			}

			// Build relationships only if we have a valid relationship type and two entities
			const relationships: Array<Record<string, unknown>> = [];
			if (entities.length >= 2 && relationshipTypes.length > 0) {
				relationships.push({
					source_entity: String(entities[0].name),
					target_entity: String(entities[1].name),
					relationship_type: relationshipTypes[0],
					confidence: 0.8,
				});
			}

			result = JSON.parse(JSON.stringify({ entities, relationships }));
		}
		// Detect entity resolution schema by checking for 'same_entity' property
		else if (hasProperty('same_entity')) {
			this.logger.debug('DevLlmService: generateStructured — returning entity resolution fixture');
			result = JSON.parse(
				JSON.stringify({
					same_entity: false,
					confidence: 0.3,
					reasoning: 'Dev mode stub: entities treated as distinct',
				}),
			);
		}
		// Detect taxonomy bootstrap schema by checking for a 'clusters' property.
		// Returns a single generic cluster so bootstrap can create at least one
		// taxonomy entry per entity type in dev/test mode.
		// See docs/specs/46_taxonomy_bootstrap.spec.md §4.3.
		else if (hasProperty('clusters')) {
			this.logger.debug('DevLlmService: generateStructured — returning taxonomy bootstrap fixture');
			result = JSON.parse(
				JSON.stringify({
					clusters: [
						{
							canonical: 'Dev Test Entity',
							aliases: ['Dev Test Alias'],
						},
					],
				}),
			);
		}
		// Detect re-ranking schema by checking for a 'rankings' property.
		// Dev mode cannot inspect prompt text to extract passage IDs, so it
		// returns an empty rankings array. The reranker contract assigns a
		// fallback score to all passages when none are in the response, which
		// makes dev-mode behavior effectively passthrough (RRF order preserved).
		// See docs/specs/41_llm_reranking.spec.md §4.5.
		else if (hasProperty('rankings')) {
			this.logger.debug('DevLlmService: generateStructured — returning rerank fixture (empty rankings)');
			result = JSON.parse(JSON.stringify({ rankings: [] }));
		} else {
			this.logger.debug('DevLlmService: generateStructured called (returning empty object)');
			result = emptyStubResponse<T>();
		}

		// Call responseValidator if provided, matching production behavior
		if (options.responseValidator) {
			const validated: unknown = options.responseValidator(result);
			// Use JSON round-trip to produce the correct generic type without `as` assertion
			result = JSON.parse(JSON.stringify(validated));
		}

		return result;
	}

	async generateText(_options: TextGenerateOptions): Promise<string> {
		this.logger.debug('DevLlmService: generateText called (returning empty string)');
		return '';
	}

	async groundedGenerate(options: GroundedGenerateOptions): Promise<GroundedGenerateResult> {
		const typeMatch = options.prompt.match(/## Entity type\s+([^\n]+)/i);
		const nameMatch = options.prompt.match(/## Entity name\s+([^\n]+)/i);
		const entityType = typeMatch?.[1]?.trim().toLowerCase() ?? 'entity';
		const entityName = nameMatch?.[1]?.trim() ?? 'Dev Test Entity';

		let coordinates: Record<string, number> | null = null;
		let attributes: Record<string, unknown> = {
			description: `Grounded context for ${entityName}`,
			place_type: null,
			region: null,
			active_dates: [],
			key_affiliations: [],
			founding_date: null,
			verified_date: null,
		};

		if (entityType === 'location') {
			coordinates = { lat: 52.52, lng: 13.405 };
			attributes = {
				...attributes,
				place_type: 'city',
				region: 'Berlin',
			};
		} else if (entityType === 'person') {
			attributes = {
				...attributes,
				key_affiliations: ['Dev Research Group'],
				active_dates: ['1999-01-01/2005-12-31'],
			};
		} else if (entityType === 'organization') {
			attributes = {
				...attributes,
				founding_date: '2001-01-01',
			};
		} else if (entityType === 'event') {
			attributes = {
				...attributes,
				verified_date: '2024-01-01',
			};
		}

		this.logger.debug({ entityName, entityType }, 'DevLlmService: groundedGenerate returning deterministic fixture');

		return {
			text: JSON.stringify({
				summary: `Grounded summary for ${entityName}`,
				confidence: 0.86,
				coordinates,
				attributes,
			}),
			groundingMetadata: {
				webSearchQueries: [entityName],
				excludedDomains: options.excludeDomains ?? [],
				geoBias: options.geoBias ?? null,
				groundingChunks: [
					{
						web: {
							uri: `https://example.com/${slugify(entityName)}`,
							title: `${entityName} reference`,
							domain: 'example.com',
						},
					},
				],
				groundingSupports: [
					{
						confidenceScores: [0.86],
					},
				],
			},
		};
	}

	async countTokens(text: string): Promise<number> {
		// Conservative dev-mode estimate: chars/2 over-counts so dev pipelines
		// split aggressively rather than under-splitting and risking truncation
		// when promoted to a real Vertex tokenizer call in prod.
		this.logger.debug({ chars: text.length }, 'DevLlmService: countTokens called (chars/2 fallback)');
		return Math.ceil(text.length / 2);
	}
}

// ────────────────────────────────────────────────────────────
// Dev Embedding Service
// ────────────────────────────────────────────────────────────

/**
 * Returns pre-recorded embedding vectors from `fixtures/embeddings/`.
 * Falls back to zero vectors if no fixture exists.
 */
class DevEmbeddingService implements EmbeddingService {
	private readonly logger: Logger;

	/** Dimensionality matching text-embedding-004 default. */
	private static readonly VECTOR_DIM = 768;

	constructor(_fixturesPath: string, logger: Logger) {
		this.logger = logger;
	}

	async embed(texts: string[]): Promise<EmbeddingResult[]> {
		this.logger.debug({ textCount: texts.length }, 'DevEmbeddingService: returning fixture/zero vectors');

		return texts.map((text) => ({
			text,
			vector: new Array<number>(DevEmbeddingService.VECTOR_DIM).fill(0),
		}));
	}
}

// ────────────────────────────────────────────────────────────
// Dev Firestore Service
// ────────────────────────────────────────────────────────────

/**
 * No-op implementation — logs instead of writing.
 * Firestore is an observability projection; dev mode doesn't need it.
 */
class DevFirestoreService implements FirestoreService {
	private readonly logger: Logger;
	private readonly store: Map<string, Record<string, unknown>>;

	constructor(logger: Logger) {
		this.logger = logger;
		this.store = new Map();
	}

	async setDocument(collection: string, documentId: string, data: Record<string, unknown>): Promise<void> {
		const key = `${collection}/${documentId}`;
		this.store.set(key, data);
		this.logger.debug({ collection, documentId }, 'DevFirestoreService: setDocument (in-memory)');
	}

	async getDocument(collection: string, documentId: string): Promise<Record<string, unknown> | null> {
		const key = `${collection}/${documentId}`;
		const result = this.store.get(key) ?? null;
		this.logger.debug({ collection, documentId, found: result !== null }, 'DevFirestoreService: getDocument');
		return result;
	}
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

/**
 * Creates dev-mode service implementations backed by the `fixtures/` directory.
 *
 * @param config - The Mulder configuration (used to resolve project root).
 * @param logger - Logger instance for debug output.
 * @returns A `Services` bundle with all fixture-based implementations.
 */
export function createDevServices(_config: MulderConfig, logger: Logger): Services {
	// fixtures/ = checked-in test data (read-only, deterministic)
	// .local/storage/ = runtime data from dev-mode pipeline runs (gitignored)
	const fixturesPath = join(process.cwd(), 'fixtures');
	const storagePath = join(process.cwd(), '.local', 'storage');

	logger.debug({ fixturesPath, storagePath }, 'Creating dev-mode services');

	return {
		storage: new DevStorageService(storagePath, fixturesPath, logger),
		documentAi: new DevDocumentAiService(fixturesPath, logger),
		llm: new DevLlmService(fixturesPath, logger),
		embedding: new DevEmbeddingService(fixturesPath, logger),
		firestore: new DevFirestoreService(logger),
	};
}
