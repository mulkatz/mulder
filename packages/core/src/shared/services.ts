/**
 * Service interfaces for the Mulder platform.
 *
 * Every GCP service is called through a typed interface. Pipeline steps
 * depend on these interfaces only — never on concrete implementations.
 * In dev mode, fixture-based implementations return pre-recorded responses.
 * In production, real GCP clients are used. Pipeline steps never know the difference.
 *
 * @see docs/specs/11_service_abstraction.spec.md §4.1
 * @see docs/functional-spec.md §4.5, §4.6
 */

// ────────────────────────────────────────────────────────────
// Service mode
// ────────────────────────────────────────────────────────────

/** Determines which service implementation layer is active. */
export type ServiceMode = 'dev' | 'gcp';

// ────────────────────────────────────────────────────────────
// Storage Service
// ────────────────────────────────────────────────────────────

/** Result from listing objects in a storage bucket/directory. */
export interface StorageListResult {
	paths: string[];
}

export interface StorageUploadSession {
	url: string;
	method: 'PUT';
	headers: Record<string, string>;
	transport: 'gcs_resumable' | 'dev_proxy';
	expiresAt: string | null;
}

export interface CreateStorageUploadSessionOptions {
	contentType: string;
	expectedSizeBytes: number;
}

export interface StorageObjectMetadata {
	sizeBytes: number;
	contentType: string | null;
}

/**
 * Abstraction over Cloud Storage.
 * Upload, download, check existence, list, and delete objects from a bucket.
 */
export interface StorageService {
	/** Upload content (Buffer or string) to a bucket path. */
	upload(bucketPath: string, content: Buffer | string, contentType?: string): Promise<void>;

	/** Create a browser-facing direct upload session for a bucket path. */
	createUploadSession(bucketPath: string, options: CreateStorageUploadSessionOptions): Promise<StorageUploadSession>;

	/** Download content from a bucket path as a Buffer. */
	download(bucketPath: string): Promise<Buffer>;

	/** Read lightweight object metadata without downloading the full object. */
	getMetadata(bucketPath: string): Promise<StorageObjectMetadata | null>;

	/** Check whether an object exists at the given bucket path. */
	exists(bucketPath: string): Promise<boolean>;

	/** List objects under a prefix path. */
	list(prefix: string): Promise<StorageListResult>;

	/** Delete an object at the given bucket path. */
	delete(bucketPath: string): Promise<void>;
}

// ────────────────────────────────────────────────────────────
// Document AI Service
// ────────────────────────────────────────────────────────────

/** Result from Document AI layout parsing. */
export interface DocumentAiResult {
	/** The raw structured JSON from Document AI Layout Parser. */
	document: Record<string, unknown>;
	/** Per-page image buffers (rendered page images). */
	pageImages: Buffer[];
}

/**
 * Abstraction over Google Document AI Layout Parser.
 * Processes a layout-oriented document and returns structured layout data with spatial information.
 */
export interface DocumentAiService {
	/** Process a layout-oriented document and return structured layout data + page images. */
	processDocument(documentContent: Buffer, sourceId: string, mediaType?: string): Promise<DocumentAiResult>;
}

// ────────────────────────────────────────────────────────────
// LLM Service
// ────────────────────────────────────────────────────────────

/** Options for structured LLM generation. */
export interface StructuredGenerateOptions {
	/** The prompt text to send. */
	prompt: string;
	/** JSON Schema that the output must conform to (sent to API for server-side enforcement). */
	schema: Record<string, unknown>;
	/** Optional system instruction. */
	systemInstruction?: string;
	/** Optional media attachments (e.g., page images). */
	media?: Array<{ mimeType: string; data: Buffer }>;
	/**
	 * Optional client-side response validator (e.g., `zodSchema.parse`).
	 * When provided, the parsed JSON response is passed through this function
	 * before being returned. Throws on validation failure.
	 */
	responseValidator?: (data: unknown) => unknown;
}

/** Options for plain text LLM generation. */
export interface TextGenerateOptions {
	/** The prompt text to send. */
	prompt: string;
	/** Optional system instruction. */
	systemInstruction?: string;
	/** Optional media attachments (e.g., page images for vision fallback). */
	media?: Array<{ mimeType: string; data: Buffer }>;
}

/** Options for grounded generation (web search). */
export interface GroundedGenerateOptions {
	/** The prompt text to send. */
	prompt: string;
	/** Optional system instruction. */
	systemInstruction?: string;
	/** Optional list of domains to exclude from Google Search results. */
	excludeDomains?: string[];
	/** Optional geographic bias when grounding a location with known coordinates. */
	geoBias?: {
		latitude: number;
		longitude: number;
	};
}

/** Result from grounded generation. */
export interface GroundedGenerateResult {
	/** The generated text. */
	text: string;
	/** Grounding metadata (search results, sources). */
	groundingMetadata: Record<string, unknown>;
}

/**
 * Abstraction over Gemini via Vertex AI.
 * Provides structured output, plain text, and grounded generation.
 */
export interface LlmService {
	/** Generate structured output conforming to a JSON schema. */
	generateStructured<T = unknown>(options: StructuredGenerateOptions): Promise<T>;

	/** Generate plain text. */
	generateText(options: TextGenerateOptions): Promise<string>;

	/** Generate text with Google Search grounding. */
	groundedGenerate(options: GroundedGenerateOptions): Promise<GroundedGenerateResult>;

	/**
	 * Count tokens for the given text against the LLM's tokenizer. Used by
	 * pre-LLM-call guards (e.g. enrich's pre-chunking check) where a
	 * character heuristic underestimates non-Latin scripts by 2-3× and risks
	 * silent mid-JSON truncation. Returns the exact tokenizer count.
	 */
	countTokens(text: string): Promise<number>;
}

// ────────────────────────────────────────────────────────────
// Embedding Service
// ────────────────────────────────────────────────────────────

/** A single embedding result for a text input. */
export interface EmbeddingResult {
	/** The original text that was embedded. */
	text: string;
	/** The embedding vector (768-dim for text-embedding-004). */
	vector: number[];
}

/**
 * Abstraction over Vertex AI text-embedding-004.
 * Embeds batches of text into vectors.
 */
export interface EmbeddingService {
	/** Embed a batch of texts into vectors. */
	embed(texts: string[]): Promise<EmbeddingResult[]>;
}

// ────────────────────────────────────────────────────────────
// Firestore Service
// ────────────────────────────────────────────────────────────

/**
 * Abstraction over Firestore (observability projection only).
 * Firestore is a write-only projection for UI monitoring — workers never read from it.
 */
export interface FirestoreService {
	/** Set a document in a collection (upsert). */
	setDocument(collection: string, documentId: string, data: Record<string, unknown>): Promise<void>;

	/** Get a document from a collection. Returns null if not found. */
	getDocument(collection: string, documentId: string): Promise<Record<string, unknown> | null>;
}

// ────────────────────────────────────────────────────────────
// Aggregate Services type
// ────────────────────────────────────────────────────────────

/**
 * Bundles all service interfaces.
 * Created by the service registry and threaded through to pipeline steps.
 */
export interface Services {
	storage: StorageService;
	documentAi: DocumentAiService;
	llm: LlmService;
	embedding: EmbeddingService;
	firestore: FirestoreService;
}
