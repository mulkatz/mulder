/**
 * GCP service implementations for the Mulder platform.
 *
 * Five classes implementing the service interfaces from `services.ts`.
 * LLM and Embedding services delegate to `VertexClient` (concurrency-limited,
 * cache-aware wrapper). Storage, Document AI, and Firestore use raw SDK
 * clients from `gcp.ts` with `withRetry` for resilience.
 *
 * @see docs/specs/13_gcp_service_implementations.spec.md §4.4
 * @see docs/specs/17_vertex_ai_wrapper_dev_cache.spec.md §4.2
 * @see docs/functional-spec.md §4.5, §4.6, §4.8
 */

import type { DocumentProcessorServiceClient, protos } from '@google-cloud/documentai';
import type { Firestore } from '@google-cloud/firestore';
import type { Storage } from '@google-cloud/storage';
import type { MulderConfig } from '../config/types.js';
import { createLlmCache, DEFAULT_CACHE_DB_PATH } from '../llm-cache.js';
import { createVertexClient, type VertexClient } from '../vertex.js';
import { ExternalServiceError } from './errors.js';
import { closeGcpClients, getDocumentAIClient, getFirestoreClient, getGenAI, getStorageClient } from './gcp.js';
import type { Logger } from './logger.js';
import { withRetry } from './retry.js';
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
 * Wraps a GCP SDK error into an `ExternalServiceError`.
 */
function wrapGcpError(
	service: 'EXT_STORAGE_FAILED' | 'EXT_DOCUMENT_AI_FAILED' | 'EXT_VERTEX_AI_FAILED',
	message: string,
	cause: unknown,
): ExternalServiceError {
	return new ExternalServiceError(message, service, {
		cause,
		context: {
			originalMessage: cause instanceof Error ? cause.message : String(cause),
		},
	});
}

// ────────────────────────────────────────────────────────────
// GCP Storage Service
// ────────────────────────────────────────────────────────────

/**
 * Cloud Storage implementation.
 * Upload, download, check existence, list, and delete objects.
 */
class GcpStorageService implements StorageService {
	constructor(
		private readonly storage: Storage,
		private readonly bucketName: string,
		private readonly logger: Logger,
	) {}

	async upload(bucketPath: string, content: Buffer | string, contentType?: string): Promise<void> {
		await withRetry(
			async () => {
				const file = this.storage.bucket(this.bucketName).file(bucketPath);
				const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
				await file.save(data, {
					contentType: contentType ?? 'application/octet-stream',
					resumable: false,
				});
				this.logger.debug({ bucketPath }, 'GcpStorageService: uploaded');
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs, bucketPath }, 'GcpStorageService: retrying upload');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_STORAGE_FAILED', `Failed to upload to ${bucketPath}`, cause);
		});
	}

	async download(bucketPath: string): Promise<Buffer> {
		return withRetry(
			async () => {
				const file = this.storage.bucket(this.bucketName).file(bucketPath);
				const [contents] = await file.download();
				this.logger.debug({ bucketPath }, 'GcpStorageService: downloaded');
				return contents;
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs, bucketPath }, 'GcpStorageService: retrying download');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_STORAGE_FAILED', `Failed to download from ${bucketPath}`, cause);
		});
	}

	async exists(bucketPath: string): Promise<boolean> {
		return withRetry(
			async () => {
				const file = this.storage.bucket(this.bucketName).file(bucketPath);
				const [fileExists] = await file.exists();
				this.logger.debug({ bucketPath, exists: fileExists }, 'GcpStorageService: checked existence');
				return fileExists;
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs, bucketPath }, 'GcpStorageService: retrying exists');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_STORAGE_FAILED', `Failed to check existence of ${bucketPath}`, cause);
		});
	}

	async list(prefix: string): Promise<StorageListResult> {
		return withRetry(
			async () => {
				const [files] = await this.storage.bucket(this.bucketName).getFiles({ prefix });
				const paths = files.map((f) => f.name);
				this.logger.debug({ prefix, count: paths.length }, 'GcpStorageService: listed');
				return { paths };
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs, prefix }, 'GcpStorageService: retrying list');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_STORAGE_FAILED', `Failed to list prefix ${prefix}`, cause);
		});
	}

	async delete(bucketPath: string): Promise<void> {
		await withRetry(
			async () => {
				const file = this.storage.bucket(this.bucketName).file(bucketPath);
				await file.delete({ ignoreNotFound: true });
				this.logger.debug({ bucketPath }, 'GcpStorageService: deleted');
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs, bucketPath }, 'GcpStorageService: retrying delete');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_STORAGE_FAILED', `Failed to delete ${bucketPath}`, cause);
		});
	}
}

// ────────────────────────────────────────────────────────────
// GCP Document AI Service
// ────────────────────────────────────────────────────────────

/**
 * Document AI Layout Parser implementation.
 * Processes PDF documents and returns structured layout data with page images.
 */
class GcpDocumentAiService implements DocumentAiService {
	constructor(
		private readonly client: DocumentProcessorServiceClient,
		private readonly processorName: string,
		private readonly logger: Logger,
	) {}

	async processDocument(pdfContent: Buffer, sourceId: string): Promise<DocumentAiResult> {
		return withRetry(
			async () => {
				this.logger.info({ sourceId, processorName: this.processorName }, 'GcpDocumentAiService: processing');

				const request: protos.google.cloud.documentai.v1.IProcessRequest = {
					name: this.processorName,
					rawDocument: {
						content: pdfContent.toString('base64'),
						mimeType: 'application/pdf',
					},
				};

				const [result] = await this.client.processDocument(request);
				const document = result.document;

				if (!document) {
					this.logger.warn({ sourceId }, 'GcpDocumentAiService: no document in response');
					return { document: {}, pageImages: [] };
				}

				// Convert the protobuf document to a plain JSON object
				const documentJson: Record<string, unknown> = JSON.parse(JSON.stringify(document));

				// Extract page images from the document pages
				const pageImages: Buffer[] = [];
				if (document.pages) {
					for (const page of document.pages) {
						if (page.image?.content) {
							// content can be string (base64) or Uint8Array
							const imageContent = page.image.content;
							if (typeof imageContent === 'string') {
								pageImages.push(Buffer.from(imageContent, 'base64'));
							} else {
								pageImages.push(Buffer.from(imageContent));
							}
						}
					}
				}

				this.logger.info({ sourceId, pageCount: pageImages.length }, 'GcpDocumentAiService: processing complete');

				return { document: documentJson, pageImages };
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs, sourceId }, 'GcpDocumentAiService: retrying processDocument');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_DOCUMENT_AI_FAILED', `Failed to process document ${sourceId}`, cause);
		});
	}
}

// ────────────────────────────────────────────────────────────
// GCP LLM Service (delegating to VertexClient)
// ────────────────────────────────────────────────────────────

/**
 * Gemini via VertexClient wrapper.
 * Delegates all calls to the concurrency-limited, cache-aware VertexClient.
 * Error wrapping is applied at this layer.
 */
class GcpLlmService implements LlmService {
	constructor(
		private readonly vertexClient: VertexClient,
		private readonly logger: Logger,
	) {}

	async generateStructured<T = unknown>(options: StructuredGenerateOptions): Promise<T> {
		try {
			this.logger.debug('GcpLlmService: generateStructured called');
			return await this.vertexClient.generateStructured<T>(options);
		} catch (cause: unknown) {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to generate structured content', cause);
		}
	}

	async generateText(options: TextGenerateOptions): Promise<string> {
		try {
			this.logger.debug('GcpLlmService: generateText called');
			return await this.vertexClient.generateText(options);
		} catch (cause: unknown) {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to generate text', cause);
		}
	}

	async groundedGenerate(options: GroundedGenerateOptions): Promise<GroundedGenerateResult> {
		try {
			this.logger.debug('GcpLlmService: groundedGenerate called');
			return await this.vertexClient.groundedGenerate(options);
		} catch (cause: unknown) {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to generate grounded content', cause);
		}
	}

	async countTokens(text: string): Promise<number> {
		try {
			this.logger.debug({ chars: text.length }, 'GcpLlmService: countTokens called');
			return await this.vertexClient.countTokens(text);
		} catch (cause: unknown) {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to count tokens', cause);
		}
	}
}

// ────────────────────────────────────────────────────────────
// GCP Embedding Service (delegating to VertexClient)
// ────────────────────────────────────────────────────────────

/**
 * Vertex AI text-embedding-004 implementation via VertexClient wrapper.
 * Delegates to VertexClient which handles concurrency limiting and caching.
 */
class GcpEmbeddingService implements EmbeddingService {
	constructor(
		private readonly vertexClient: VertexClient,
		private readonly model: string,
		private readonly dimensions: number,
		private readonly logger: Logger,
	) {}

	async embed(texts: string[]): Promise<EmbeddingResult[]> {
		if (texts.length === 0) {
			return [];
		}

		try {
			this.logger.debug({ textCount: texts.length }, 'GcpEmbeddingService: embedding texts');
			return await this.vertexClient.embed(texts, this.model, this.dimensions);
		} catch (cause: unknown) {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to embed texts', cause);
		}
	}
}

// ────────────────────────────────────────────────────────────
// GCP Firestore Service
// ────────────────────────────────────────────────────────────

/**
 * Firestore implementation — write-only observability projection.
 * Fire-and-forget pattern: logs errors but does not throw.
 * Workers never read from Firestore for orchestration decisions.
 */
class GcpFirestoreService implements FirestoreService {
	constructor(
		private readonly firestore: Firestore,
		private readonly logger: Logger,
	) {}

	async setDocument(collection: string, documentId: string, data: Record<string, unknown>): Promise<void> {
		try {
			await this.firestore.collection(collection).doc(documentId).set(data, { merge: true });
			this.logger.debug({ collection, documentId }, 'GcpFirestoreService: setDocument');
		} catch (error: unknown) {
			// Fire-and-forget: log but don't throw — Firestore is observability only
			this.logger.error({ err: error, collection, documentId }, 'GcpFirestoreService: setDocument failed (non-fatal)');
		}
	}

	async getDocument(collection: string, documentId: string): Promise<Record<string, unknown> | null> {
		try {
			const doc = await this.firestore.collection(collection).doc(documentId).get();
			if (!doc.exists) {
				this.logger.debug({ collection, documentId, found: false }, 'GcpFirestoreService: getDocument');
				return null;
			}
			const data = doc.data();
			this.logger.debug({ collection, documentId, found: true }, 'GcpFirestoreService: getDocument');
			return data ?? null;
		} catch (error: unknown) {
			// Fire-and-forget: log but don't throw
			this.logger.error({ err: error, collection, documentId }, 'GcpFirestoreService: getDocument failed (non-fatal)');
			return null;
		}
	}
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

/**
 * Creates GCP service implementations using real SDK clients.
 *
 * Constructs all GCP clients via `gcp.ts` getters, creates a
 * `VertexClient` (with optional dev cache), then creates
 * service instances. Returns the `Services` bundle.
 *
 * Cache is enabled via `MULDER_LLM_CACHE=true` environment variable.
 *
 * @param config - The validated Mulder configuration (gcp section must exist).
 * @param logger - Logger instance for service operation logging.
 * @returns A `Services` bundle with all GCP-backed implementations.
 */
export function createGcpServices(config: MulderConfig, logger: Logger): Services {
	const gcp = config.gcp;
	if (!gcp) {
		throw new ExternalServiceError('GCP configuration is required for production mode', 'EXT_STORAGE_FAILED', {
			context: { hint: 'Set dev_mode: true or provide gcp configuration' },
		});
	}

	const projectId = gcp.project_id;
	const region = gcp.region;
	const bucket = gcp.storage.bucket;
	const processorId = gcp.document_ai.processor_id;
	// Document AI uses its own multi-region endpoint (eu | us), separate from
	// gcp.region which is the Cloud Run / Cloud SQL location.
	const processorLocation = gcp.document_ai.location;
	const processorName = `projects/${projectId}/locations/${processorLocation}/processors/${processorId}`;

	logger.debug({ projectId, region, bucket }, 'Creating GCP services');

	// Initialize SDK clients via connection manager
	const storageClient = getStorageClient();
	const documentAiClient = getDocumentAIClient();
	const ai = getGenAI(projectId, region);
	const firestoreClient = getFirestoreClient(projectId);

	// Embedding config with defaults
	const embeddingModel = config.embedding.model;
	const embeddingDimensions = config.embedding.storage_dimensions;

	// Create LLM cache if enabled via env var
	const cacheEnabled = process.env.MULDER_LLM_CACHE === 'true';
	const cache = cacheEnabled ? createLlmCache(DEFAULT_CACHE_DB_PATH, logger) : undefined;

	if (cacheEnabled) {
		logger.info({ dbPath: DEFAULT_CACHE_DB_PATH }, 'LLM response cache enabled');
	}

	// Create VertexClient with concurrency limiter and optional cache
	const vertexClient = createVertexClient(ai, {
		maxConcurrentRequests: config.vertex.max_concurrent_requests,
		cache,
		logger,
	});

	return {
		storage: new GcpStorageService(storageClient, bucket, logger),
		documentAi: new GcpDocumentAiService(documentAiClient, processorName, logger),
		llm: new GcpLlmService(vertexClient, logger),
		embedding: new GcpEmbeddingService(vertexClient, embeddingModel, embeddingDimensions, logger),
		firestore: new GcpFirestoreService(firestoreClient, logger),
	};
}

export { closeGcpClients };
