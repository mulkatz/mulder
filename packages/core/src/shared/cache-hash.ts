/**
 * Deterministic cache key computation for LLM response caching.
 *
 * Produces a SHA-256 hash from the request parameters (model, prompt,
 * schema, systemInstruction). Keys are sorted before stringification
 * to ensure determinism regardless of property insertion order.
 *
 * @see docs/specs/17_vertex_ai_wrapper_dev_cache.spec.md §4.1
 * @see docs/functional-spec.md §4.8
 */

import { createHash } from 'node:crypto';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Parameters used to compute a deterministic cache key. */
export interface CacheKeyParams {
	model: string;
	prompt: string;
	schema?: Record<string, unknown>;
	systemInstruction?: string;
}

// ────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────

/**
 * Recursively sorts object keys for deterministic JSON serialization.
 * Arrays are preserved in order; primitives are returned as-is.
 */
function sortKeys(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value);
		entries.sort(([a], [b]) => a.localeCompare(b));
		const sorted: Record<string, unknown> = {};
		for (const [key, val] of entries) {
			sorted[key] = sortKeys(val);
		}
		return sorted;
	}
	return value;
}

/**
 * Computes a deterministic SHA-256 cache key from request parameters.
 *
 * Keys are sorted recursively before stringification to ensure that
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same hash.
 *
 * @param params - The request parameters to hash.
 * @returns A hex-encoded SHA-256 hash string.
 */
export function computeCacheKey(params: CacheKeyParams): string {
	const sorted = sortKeys(params);
	const serialized = JSON.stringify(sorted);
	return createHash('sha256').update(serialized).digest('hex');
}
