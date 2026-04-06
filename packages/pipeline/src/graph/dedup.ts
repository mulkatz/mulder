/**
 * Deduplication module — MinHash on chunk embeddings to detect near-duplicate stories.
 *
 * Computes MinHash signatures from quantized embedding dimensions, then compares
 * via Jaccard estimation. Lightweight implementation — no heavy npm dependencies.
 *
 * @see docs/specs/35_graph_step.spec.md §4.2
 * @see docs/functional-spec.md §2.7 (dedup before corroboration)
 */

import { type Chunk, findChunksByStoryId, findEntitiesByStoryId } from '@mulder/core';
import type pg from 'pg';
import type { DuplicatePair } from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

/** Number of hash functions for the MinHash signature. */
const NUM_HASHES = 128;

/** Quantization precision: round to nearest 0.1 */
const QUANTIZATION_FACTOR = 10;

/** Large prime for hash computation. */
const LARGE_PRIME = 4294967311; // 2^32 + 15, a prime larger than 2^32

// ────────────────────────────────────────────────────────────
// Hash functions (lightweight murmurhash-inspired)
// ────────────────────────────────────────────────────────────

/**
 * Pre-generated random coefficients for MinHash functions.
 * Using deterministic seeds for reproducibility.
 */
function generateHashCoefficients(count: number): Array<{ a: number; b: number }> {
	const coefficients: Array<{ a: number; b: number }> = [];
	// Use a simple LCG-based PRNG for deterministic coefficient generation
	let seed = 42;
	for (let i = 0; i < count; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		const a = (seed % (LARGE_PRIME - 1)) + 1;
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		const b = seed % LARGE_PRIME;
		coefficients.push({ a, b });
	}
	return coefficients;
}

const HASH_COEFFICIENTS = generateHashCoefficients(NUM_HASHES);

/**
 * Simple string hash function (FNV-1a inspired).
 * Converts a shingle string to a 32-bit integer.
 */
function hashString(str: string): number {
	let hash = 2166136261;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0; // Convert to unsigned 32-bit
}

// ────────────────────────────────────────────────────────────
// MinHash signature computation
// ────────────────────────────────────────────────────────────

/**
 * Converts a set of embedding vectors to a set of shingle strings.
 *
 * For each embedding dimension, we quantize to nearest 0.1 and create
 * a token combining dimension index + quantized value.
 */
function embeddingsToShingleSet(embeddings: number[][]): Set<string> {
	const shingles = new Set<string>();

	for (const embedding of embeddings) {
		for (let dim = 0; dim < embedding.length; dim++) {
			const quantized = Math.round(embedding[dim] * QUANTIZATION_FACTOR) / QUANTIZATION_FACTOR;
			shingles.add(`${dim}:${quantized}`);
		}
	}

	return shingles;
}

/**
 * Computes a MinHash signature for a set of shingles.
 *
 * For each hash function h_i(x) = (a_i * hash(x) + b_i) % LARGE_PRIME,
 * the signature value is min(h_i(x)) for all x in the shingle set.
 */
function computeMinHashSignature(shingleSet: Set<string>): Uint32Array {
	const signature = new Uint32Array(NUM_HASHES);
	signature.fill(0xffffffff); // Initialize to max

	for (const shingle of shingleSet) {
		const shingleHash = hashString(shingle);

		for (let i = 0; i < NUM_HASHES; i++) {
			const { a, b } = HASH_COEFFICIENTS[i];
			// h(x) = (a * x + b) % prime
			const hashValue = Number((BigInt(a) * BigInt(shingleHash) + BigInt(b)) % BigInt(LARGE_PRIME));
			if (hashValue < signature[i]) {
				signature[i] = hashValue;
			}
		}
	}

	return signature;
}

/**
 * Estimates Jaccard similarity between two MinHash signatures.
 * Similarity = (number of matching positions) / (total positions).
 */
function estimateJaccardSimilarity(sigA: Uint32Array, sigB: Uint32Array): number {
	let matches = 0;
	for (let i = 0; i < NUM_HASHES; i++) {
		if (sigA[i] === sigB[i]) {
			matches++;
		}
	}
	return matches / NUM_HASHES;
}

/**
 * Classifies a duplicate type based on similarity score.
 *
 * - >= 0.99 -> exact
 * - >= 0.95 -> reprint
 * - >= 0.90 -> near
 * - summary type requires LLM (v2.0) -- not assigned here
 */
function classifyDuplicateType(similarity: number): 'exact' | 'reprint' | 'near' {
	if (similarity >= 0.99) return 'exact';
	if (similarity >= 0.95) return 'reprint';
	return 'near';
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Detects near-duplicate stories by computing MinHash signatures
 * from chunk embeddings and comparing against other stories that
 * share entities with the current story.
 *
 * Only compares against stories that share at least one entity
 * (via story_entities join) to avoid O(n^2) full-corpus scan.
 *
 * @param pool - PostgreSQL connection pool
 * @param storyId - The story to check for duplicates
 * @param threshold - Similarity threshold (default 0.90)
 * @returns Array of duplicate pairs above the threshold
 */
export async function detectDuplicates(pool: pg.Pool, storyId: string, threshold: number): Promise<DuplicatePair[]> {
	// 1. Get chunks with embeddings for the target story
	const targetChunks = await findChunksByStoryId(pool, storyId);
	const targetEmbeddings = extractEmbeddings(targetChunks);

	if (targetEmbeddings.length === 0) {
		return [];
	}

	// 2. Compute MinHash signature for the target story
	const targetShingles = embeddingsToShingleSet(targetEmbeddings);
	const targetSignature = computeMinHashSignature(targetShingles);

	// 3. Find candidate stories to compare against (stories sharing entities)
	const entities = await findEntitiesByStoryId(pool, storyId);
	const candidateStoryIds = new Set<string>();

	for (const entity of entities) {
		// Query story_entities to find other stories with this entity
		const result = await pool.query<{ story_id: string }>(
			`SELECT DISTINCT se.story_id FROM story_entities se
			 WHERE se.entity_id = $1 AND se.story_id != $2`,
			[entity.id, storyId],
		);
		for (const row of result.rows) {
			candidateStoryIds.add(row.story_id);
		}
	}

	if (candidateStoryIds.size === 0) {
		return [];
	}

	// 4. Compare against each candidate
	const duplicates: DuplicatePair[] = [];

	for (const candidateId of candidateStoryIds) {
		const candidateChunks = await findChunksByStoryId(pool, candidateId);
		const candidateEmbeddings = extractEmbeddings(candidateChunks);

		if (candidateEmbeddings.length === 0) {
			continue;
		}

		const candidateShingles = embeddingsToShingleSet(candidateEmbeddings);
		const candidateSignature = computeMinHashSignature(candidateShingles);

		const similarity = estimateJaccardSimilarity(targetSignature, candidateSignature);

		if (similarity >= threshold) {
			duplicates.push({
				storyIdA: storyId,
				storyIdB: candidateId,
				similarity,
				duplicateType: classifyDuplicateType(similarity),
			});
		}
	}

	return duplicates;
}

/**
 * Extracts non-null embedding arrays from chunks.
 * Only includes content chunks (not questions).
 */
function extractEmbeddings(chunks: Chunk[]): number[][] {
	const embeddings: number[][] = [];
	for (const chunk of chunks) {
		if (!chunk.isQuestion && chunk.embedding !== null) {
			embeddings.push(chunk.embedding);
		}
	}
	return embeddings;
}
