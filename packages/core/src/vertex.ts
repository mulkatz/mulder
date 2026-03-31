/**
 * Vertex AI wrapper — concurrency-limited, cache-aware wrapper for all
 * Vertex AI calls (Gemini structured output, text generation, grounded
 * generation, and embeddings).
 *
 * All pipeline steps call these functions via the service interfaces,
 * never the Vertex AI SDK directly.
 *
 * **Concurrency limiter:** A process-level `p-limit` throttle prevents
 * thundering herd 429s when multiple jobs fire simultaneous requests.
 * Configurable via `vertex.max_concurrent_requests` (default: 2).
 *
 * **Dev cache:** When an `LlmCache` is injected (dev mode), responses
 * are cached by SHA-256 hash of (model + prompt + schema + systemInstruction).
 * Grounded generate calls are NOT cached (web results are time-sensitive).
 *
 * @see docs/specs/17_vertex_ai_wrapper_dev_cache.spec.md §4.1
 * @see docs/functional-spec.md §4.8
 */

import type { GoogleGenAI } from '@google/genai';
import pLimit from 'p-limit';
import type { LlmCache } from './llm-cache.js';
import { computeCacheKey } from './shared/cache-hash.js';
import type { Logger } from './shared/logger.js';
import { withRetry } from './shared/retry.js';
import type {
	EmbeddingResult,
	GroundedGenerateOptions,
	GroundedGenerateResult,
	StructuredGenerateOptions,
	TextGenerateOptions,
} from './shared/services.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Configuration for the Vertex AI client wrapper. */
export interface VertexClientOptions {
	/** Maximum concurrent Vertex AI requests per worker process. Default: 2. */
	maxConcurrentRequests: number;
	/** LLM response cache (injected in dev mode, undefined in prod). */
	cache?: LlmCache;
	/** Logger instance. */
	logger: Logger;
}

/** Concurrency-limited, cache-aware Vertex AI client. */
export interface VertexClient {
	/** Generate structured output conforming to a JSON schema. */
	generateStructured<T = unknown>(options: StructuredGenerateOptions): Promise<T>;
	/** Generate plain text. */
	generateText(options: TextGenerateOptions): Promise<string>;
	/** Generate text with Google Search grounding (NOT cached). */
	groundedGenerate(options: GroundedGenerateOptions): Promise<GroundedGenerateResult>;
	/** Embed texts into vectors. */
	embed(texts: string[], model: string, dimensions: number): Promise<EmbeddingResult[]>;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-2.5-flash';

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

/**
 * Builds the contents parameter for generateContent.
 * Returns a simple string for text-only, or structured parts for multimodal.
 */
function buildContents(
	prompt: string,
	media?: Array<{ mimeType: string; data: Buffer }>,
): string | Array<{ role: string; parts: Array<Record<string, unknown>> }> {
	if (!media || media.length === 0) {
		return prompt;
	}

	const parts: Array<Record<string, unknown>> = [{ text: prompt }];
	for (const m of media) {
		parts.push({
			inlineData: {
				mimeType: m.mimeType,
				data: m.data.toString('base64'),
			},
		});
	}

	return [{ role: 'user', parts }];
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

/**
 * Creates a concurrency-limited, cache-aware Vertex AI client.
 *
 * @param ai - The raw GoogleGenAI SDK instance (from `gcp.ts`).
 * @param options - Client options (concurrency limit, optional cache, logger).
 * @returns A `VertexClient` with all Vertex AI methods.
 */
export function createVertexClient(ai: GoogleGenAI, options: VertexClientOptions): VertexClient {
	const { maxConcurrentRequests, cache, logger } = options;
	const limiter = pLimit(maxConcurrentRequests);

	logger.debug({ maxConcurrentRequests, cacheEnabled: cache !== undefined }, 'VertexClient: initialized');

	return {
		async generateStructured<T = unknown>(opts: StructuredGenerateOptions): Promise<T> {
			// Check cache first (if enabled)
			if (cache) {
				const cacheKey = computeCacheKey({
					model: DEFAULT_MODEL,
					prompt: opts.prompt,
					schema: opts.schema,
					systemInstruction: opts.systemInstruction,
				});

				const cached = cache.get(cacheKey);
				if (cached) {
					logger.warn(
						{ model: cached.model, tokensSaved: cached.tokens_saved },
						'VertexClient: cache hit (generateStructured)',
					);
					return JSON.parse(cached.response);
				}

				// Cache miss — make the API call through the limiter
				return limiter(async () => {
					const response = await withRetry(
						async () => {
							const contents = buildContents(opts.prompt, opts.media);
							return ai.models.generateContent({
								model: DEFAULT_MODEL,
								contents,
								config: {
									responseMimeType: 'application/json',
									responseSchema: opts.schema,
									systemInstruction: opts.systemInstruction,
								},
							});
						},
						{
							onRetry: (err, attempt, delayMs) => {
								logger.warn({ err, attempt, delayMs }, 'VertexClient: retrying generateStructured');
							},
						},
					);

					const responseText = response.text ?? '{}';
					const tokensSaved = response.usageMetadata?.totalTokenCount ?? 0;

					cache.set(cacheKey, {
						response: responseText,
						model: DEFAULT_MODEL,
						tokens_saved: tokensSaved,
					});

					return JSON.parse(responseText);
				});
			}

			// No cache — just limiter + retry
			return limiter(async () => {
				const response = await withRetry(
					async () => {
						const contents = buildContents(opts.prompt, opts.media);
						return ai.models.generateContent({
							model: DEFAULT_MODEL,
							contents,
							config: {
								responseMimeType: 'application/json',
								responseSchema: opts.schema,
								systemInstruction: opts.systemInstruction,
							},
						});
					},
					{
						onRetry: (err, attempt, delayMs) => {
							logger.warn({ err, attempt, delayMs }, 'VertexClient: retrying generateStructured');
						},
					},
				);

				const responseText = response.text ?? '{}';
				return JSON.parse(responseText);
			});
		},

		async generateText(opts: TextGenerateOptions): Promise<string> {
			// Check cache first (if enabled)
			if (cache) {
				const cacheKey = computeCacheKey({
					model: DEFAULT_MODEL,
					prompt: opts.prompt,
					systemInstruction: opts.systemInstruction,
				});

				const cached = cache.get(cacheKey);
				if (cached) {
					logger.warn(
						{ model: cached.model, tokensSaved: cached.tokens_saved },
						'VertexClient: cache hit (generateText)',
					);
					return cached.response;
				}

				return limiter(async () => {
					const response = await withRetry(
						async () => {
							const contents = buildContents(opts.prompt, opts.media);
							return ai.models.generateContent({
								model: DEFAULT_MODEL,
								contents,
								config: {
									systemInstruction: opts.systemInstruction,
								},
							});
						},
						{
							onRetry: (err, attempt, delayMs) => {
								logger.warn({ err, attempt, delayMs }, 'VertexClient: retrying generateText');
							},
						},
					);

					const text = response.text ?? '';
					const tokensSaved = response.usageMetadata?.totalTokenCount ?? 0;

					cache.set(cacheKey, {
						response: text,
						model: DEFAULT_MODEL,
						tokens_saved: tokensSaved,
					});

					return text;
				});
			}

			return limiter(async () => {
				const response = await withRetry(
					async () => {
						const contents = buildContents(opts.prompt, opts.media);
						return ai.models.generateContent({
							model: DEFAULT_MODEL,
							contents,
							config: {
								systemInstruction: opts.systemInstruction,
							},
						});
					},
					{
						onRetry: (err, attempt, delayMs) => {
							logger.warn({ err, attempt, delayMs }, 'VertexClient: retrying generateText');
						},
					},
				);

				return response.text ?? '';
			});
		},

		async groundedGenerate(opts: GroundedGenerateOptions): Promise<GroundedGenerateResult> {
			// Grounded generate is NOT cached — web results are time-sensitive
			return limiter(async () => {
				const response = await withRetry(
					async () => {
						return ai.models.generateContent({
							model: DEFAULT_MODEL,
							contents: opts.prompt,
							config: {
								tools: [{ googleSearch: {} }],
								systemInstruction: opts.systemInstruction,
							},
						});
					},
					{
						onRetry: (err, attempt, delayMs) => {
							logger.warn({ err, attempt, delayMs }, 'VertexClient: retrying groundedGenerate');
						},
					},
				);

				const text = response.text ?? '';
				const metadata = response.candidates?.[0]?.groundingMetadata;
				const groundingMetadata: Record<string, unknown> = metadata
					? toRecord(JSON.parse(JSON.stringify(metadata)))
					: {};

				return { text, groundingMetadata };
			});
		},

		async embed(texts: string[], model: string, dimensions: number): Promise<EmbeddingResult[]> {
			if (texts.length === 0) {
				return [];
			}

			// Check cache for embeddings (if enabled)
			if (cache) {
				const cacheKey = computeCacheKey({
					model,
					prompt: JSON.stringify(texts),
					schema: { outputDimensionality: dimensions },
				});

				const cached = cache.get(cacheKey);
				if (cached) {
					logger.warn(
						{ model: cached.model, tokensSaved: cached.tokens_saved, textCount: texts.length },
						'VertexClient: cache hit (embed)',
					);
					return JSON.parse(cached.response);
				}

				return limiter(async () => {
					const response = await withRetry(
						async () => {
							return ai.models.embedContent({
								model,
								contents: texts,
								config: {
									outputDimensionality: dimensions,
								},
							});
						},
						{
							onRetry: (err, attempt, delayMs) => {
								logger.warn({ err, attempt, delayMs }, 'VertexClient: retrying embed');
							},
						},
					);

					const embeddings = response.embeddings ?? [];
					const results: EmbeddingResult[] = texts.map((text, i) => ({
						text,
						vector: embeddings[i]?.values ?? [],
					}));

					cache.set(cacheKey, {
						response: JSON.stringify(results),
						model,
						tokens_saved: texts.length, // Approximate: 1 token per text for tracking
					});

					return results;
				});
			}

			return limiter(async () => {
				const response = await withRetry(
					async () => {
						return ai.models.embedContent({
							model,
							contents: texts,
							config: {
								outputDimensionality: dimensions,
							},
						});
					},
					{
						onRetry: (err, attempt, delayMs) => {
							logger.warn({ err, attempt, delayMs }, 'VertexClient: retrying embed');
						},
					},
				);

				const embeddings = response.embeddings ?? [];
				return texts.map((text, i) => ({
					text,
					vector: embeddings[i]?.values ?? [],
				}));
			});
		},
	};
}
