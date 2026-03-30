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

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

// ────────────────────────────────────────────────────────────
// Dev Storage Service
// ────────────────────────────────────────────────────────────

/**
 * Reads/writes to local `fixtures/` directory instead of GCS.
 * Bucket paths are mapped to filesystem paths relative to `fixturesPath`.
 */
class DevStorageService implements StorageService {
	private readonly basePath: string;
	private readonly logger: Logger;

	constructor(fixturesPath: string, logger: Logger) {
		this.basePath = fixturesPath;
		this.logger = logger;
	}

	async upload(bucketPath: string, content: Buffer | string, _contentType?: string): Promise<void> {
		const fullPath = join(this.basePath, bucketPath);
		const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
		mkdirSync(dir, { recursive: true });
		writeFileSync(fullPath, content);
		this.logger.debug({ bucketPath }, 'DevStorageService: uploaded to fixtures');
	}

	async download(bucketPath: string): Promise<Buffer> {
		const fullPath = join(this.basePath, bucketPath);
		this.logger.debug({ bucketPath }, 'DevStorageService: downloading from fixtures');
		return readFileSync(fullPath);
	}

	async exists(bucketPath: string): Promise<boolean> {
		const fullPath = join(this.basePath, bucketPath);
		const result = existsSync(fullPath);
		this.logger.debug({ bucketPath, exists: result }, 'DevStorageService: checking existence');
		return result;
	}

	async list(prefix: string): Promise<StorageListResult> {
		const fullPath = join(this.basePath, prefix);
		if (!existsSync(fullPath)) {
			this.logger.debug({ prefix, count: 0 }, 'DevStorageService: listing (dir not found)');
			return { paths: [] };
		}
		const entries = readdirSync(fullPath, { recursive: true, withFileTypes: true });
		const paths = entries
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const entryDir = typeof entry.parentPath === 'string' ? entry.parentPath : entry.path;
				const relativePath = entryDir.replace(this.basePath, '').replace(/^\//, '');
				return `${relativePath}/${entry.name}`;
			});
		this.logger.debug({ prefix, count: paths.length }, 'DevStorageService: listing');
		return { paths };
	}

	async delete(bucketPath: string): Promise<void> {
		const fullPath = join(this.basePath, bucketPath);
		if (existsSync(fullPath)) {
			unlinkSync(fullPath);
		}
		this.logger.debug({ bucketPath }, 'DevStorageService: deleted from fixtures');
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
 */
class DevLlmService implements LlmService {
	private readonly basePath: string;
	private readonly logger: Logger;

	constructor(fixturesPath: string, logger: Logger) {
		this.basePath = fixturesPath;
		this.logger = logger;
	}

	async generateStructured<T = unknown>(_options: StructuredGenerateOptions): Promise<T> {
		this.logger.debug('DevLlmService: generateStructured called (returning empty object)');
		return emptyStubResponse<T>();
	}

	async generateText(_options: TextGenerateOptions): Promise<string> {
		this.logger.debug('DevLlmService: generateText called (returning empty string)');
		return '';
	}

	async groundedGenerate(_options: GroundedGenerateOptions): Promise<GroundedGenerateResult> {
		this.logger.debug('DevLlmService: groundedGenerate called (returning empty result)');
		return { text: '', groundingMetadata: {} };
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
	private readonly basePath: string;
	private readonly logger: Logger;

	/** Dimensionality matching text-embedding-004 default. */
	private static readonly VECTOR_DIM = 768;

	constructor(fixturesPath: string, logger: Logger) {
		this.basePath = join(fixturesPath, 'embeddings');
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
export function createDevServices(config: MulderConfig, logger: Logger): Services {
	// Resolve fixtures path relative to project root.
	// In dev mode, fixtures/ is at the repo root.
	const fixturesPath = join(process.cwd(), 'fixtures');

	logger.debug({ fixturesPath }, 'Creating dev-mode services from fixtures');

	return {
		storage: new DevStorageService(fixturesPath, logger),
		documentAi: new DevDocumentAiService(fixturesPath, logger),
		llm: new DevLlmService(fixturesPath, logger),
		embedding: new DevEmbeddingService(fixturesPath, logger),
		firestore: new DevFirestoreService(logger),
	};
}
