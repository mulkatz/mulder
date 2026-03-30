/**
 * GCP service implementations for the Mulder platform.
 *
 * Five classes implementing the service interfaces from `services.ts`.
 * Each receives raw SDK clients from `gcp.ts` via constructor injection,
 * uses `withRetry` for resilience, and throws `ExternalServiceError` on failure.
 *
 * @see docs/specs/13_gcp_service_implementations.spec.md §4.4
 * @see docs/functional-spec.md §4.5, §4.6
 */

import type { protos } from '@google-cloud/documentai';
import type { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import type { Firestore } from '@google-cloud/firestore';
import type { Storage } from '@google-cloud/storage';
import type { GenerateContentResult, VertexAI } from '@google-cloud/vertexai';
import { GoogleAuth } from 'google-auth-library';
import type { MulderConfig } from '../config/types.js';
import { ExternalServiceError } from './errors.js';
import { closeGcpClients, getDocumentAIClient, getFirestoreClient, getStorageClient, getVertexAI } from './gcp.js';
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

/**
 * Converts a JSON-serializable value to a target type via round-trip serialization.
 * Used for external API response boundaries where runtime values are trusted
 * but TypeScript cannot infer the type statically.
 */
function jsonRoundTrip<T>(value: unknown): T {
	return JSON.parse(JSON.stringify(value));
}

/**
 * Converts an unknown JSON-parsed value into a plain `Record<string, unknown>`.
 * Returns an empty object if the value is not a plain object.
 */
function toRecord(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return Object.fromEntries(Object.entries(value));
	}
	return {};
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
// GCP LLM Service
// ────────────────────────────────────────────────────────────

/**
 * Gemini via Vertex AI implementation.
 * Provides structured output, plain text, and grounded generation.
 */
class GcpLlmService implements LlmService {
	private static readonly DEFAULT_MODEL = 'gemini-2.5-flash';

	constructor(
		private readonly vertexAi: VertexAI,
		private readonly logger: Logger,
	) {}

	async generateStructured<T = unknown>(options: StructuredGenerateOptions): Promise<T> {
		return withRetry(
			async () => {
				this.logger.debug('GcpLlmService: generateStructured called');

				// Convert schema via JSON round-trip (options.schema is Record, SDK expects ResponseSchema)
				const generationConfig: Record<string, unknown> = {
					responseMimeType: 'application/json',
					responseSchema: JSON.parse(JSON.stringify(options.schema)),
				};

				const model = this.vertexAi.getGenerativeModel({
					model: GcpLlmService.DEFAULT_MODEL,
					generationConfig: jsonRoundTrip(generationConfig),
					systemInstruction: options.systemInstruction
						? { role: 'system', parts: [{ text: options.systemInstruction }] }
						: undefined,
				});

				const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
					{ text: options.prompt },
				];

				if (options.media) {
					for (const m of options.media) {
						parts.push({
							inlineData: {
								mimeType: m.mimeType,
								data: m.data.toString('base64'),
							},
						});
					}
				}

				const result: GenerateContentResult = await model.generateContent({
					contents: [{ role: 'user', parts }],
				});

				const responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

				// Parse and return via round-trip (external API response pattern)
				return jsonRoundTrip<T>(JSON.parse(responseText));
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs }, 'GcpLlmService: retrying generateStructured');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to generate structured content', cause);
		});
	}

	async generateText(options: TextGenerateOptions): Promise<string> {
		return withRetry(
			async () => {
				this.logger.debug('GcpLlmService: generateText called');

				const model = this.vertexAi.getGenerativeModel({
					model: GcpLlmService.DEFAULT_MODEL,
					systemInstruction: options.systemInstruction
						? { role: 'system', parts: [{ text: options.systemInstruction }] }
						: undefined,
				});

				const result: GenerateContentResult = await model.generateContent({
					contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
				});

				return result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs }, 'GcpLlmService: retrying generateText');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to generate text', cause);
		});
	}

	async groundedGenerate(options: GroundedGenerateOptions): Promise<GroundedGenerateResult> {
		return withRetry(
			async () => {
				this.logger.debug('GcpLlmService: groundedGenerate called');

				const model = this.vertexAi.getGenerativeModel({
					model: GcpLlmService.DEFAULT_MODEL,
					tools: [{ googleSearchRetrieval: {} }],
					systemInstruction: options.systemInstruction
						? { role: 'system', parts: [{ text: options.systemInstruction }] }
						: undefined,
				});

				const result: GenerateContentResult = await model.generateContent({
					contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
				});

				const candidate = result.response.candidates?.[0];
				const text = candidate?.content?.parts?.[0]?.text ?? '';
				const groundingMetadata: Record<string, unknown> = candidate?.groundingMetadata
					? toRecord(JSON.parse(JSON.stringify(candidate.groundingMetadata)))
					: {};

				return { text, groundingMetadata };
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs }, 'GcpLlmService: retrying groundedGenerate');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to generate grounded content', cause);
		});
	}
}

// ────────────────────────────────────────────────────────────
// GCP Embedding Service
// ────────────────────────────────────────────────────────────

/** Response shape from the Vertex AI text-embedding prediction API. */
interface EmbeddingPrediction {
	embeddings: {
		values: number[];
	};
}

/** Response from the Vertex AI prediction endpoint. */
interface PredictionResponse {
	predictions: EmbeddingPrediction[];
}

/**
 * Vertex AI text-embedding-004 implementation.
 * Uses the Vertex AI prediction REST API for embeddings since the
 * `@google-cloud/vertexai` SDK focuses on generative models.
 *
 * Passes `outputDimensionality` parameter from config (default 768).
 * NEVER truncates vectors manually.
 */
class GcpEmbeddingService implements EmbeddingService {
	private readonly auth: GoogleAuth;
	private readonly endpoint: string;

	constructor(
		private readonly project: string,
		private readonly location: string,
		private readonly model: string,
		private readonly dimensions: number,
		private readonly logger: Logger,
	) {
		this.auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
		this.endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;
	}

	async embed(texts: string[]): Promise<EmbeddingResult[]> {
		if (texts.length === 0) {
			return [];
		}

		return withRetry(
			async () => {
				this.logger.debug({ textCount: texts.length }, 'GcpEmbeddingService: embedding texts');

				const client = await this.auth.getClient();
				const token = await client.getAccessToken();

				const body = {
					instances: texts.map((text) => ({ content: text })),
					parameters: {
						outputDimensionality: this.dimensions,
					},
				};

				const response = await fetch(this.endpoint, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token.token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(body),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Embedding API returned ${String(response.status)}: ${errorText}`);
				}

				// Use JSON.parse(text) instead of response.json() to get proper typing
				const data: PredictionResponse = JSON.parse(await response.text());

				const results: EmbeddingResult[] = texts.map((text, i) => ({
					text,
					vector: data.predictions[i].embeddings.values,
				}));

				this.logger.debug(
					{ textCount: texts.length, dimensions: this.dimensions },
					'GcpEmbeddingService: embedding complete',
				);

				return results;
			},
			{
				onRetry: (err, attempt, delayMs) => {
					this.logger.warn({ err, attempt, delayMs }, 'GcpEmbeddingService: retrying embed');
				},
			},
		).catch((cause: unknown) => {
			throw wrapGcpError('EXT_VERTEX_AI_FAILED', 'Failed to embed texts', cause);
		});
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
 * Constructs all GCP clients via `gcp.ts` getters, then creates
 * service instances. Returns the `Services` bundle.
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
	const processorName = `projects/${projectId}/locations/${region}/processors/${processorId}`;

	logger.debug({ projectId, region, bucket }, 'Creating GCP services');

	// Initialize SDK clients via connection manager
	const storageClient = getStorageClient();
	const documentAiClient = getDocumentAIClient();
	const vertexAi = getVertexAI(projectId, region);
	const firestoreClient = getFirestoreClient(projectId);

	// Embedding config with defaults
	const embeddingModel = config.embedding.model;
	const embeddingDimensions = config.embedding.storage_dimensions;

	return {
		storage: new GcpStorageService(storageClient, bucket, logger),
		documentAi: new GcpDocumentAiService(documentAiClient, processorName, logger),
		llm: new GcpLlmService(vertexAi, logger),
		embedding: new GcpEmbeddingService(projectId, region, embeddingModel, embeddingDimensions, logger),
		firestore: new GcpFirestoreService(firestoreClient, logger),
	};
}

export { closeGcpClients };
