/**
 * CER (Character Error Rate) and WER (Word Error Rate) computation.
 *
 * Uses Levenshtein distance (standard dynamic programming edit distance)
 * at character level for CER and word level for WER.
 *
 * @see docs/specs/21_golden_test_set_extraction.spec.md §4.3
 * @see docs/functional-spec.md §15.2
 */

// ────────────────────────────────────────────────────────────
// Text normalization
// ────────────────────────────────────────────────────────────

/**
 * Normalize whitespace in text for consistent comparison.
 * Collapses runs of whitespace to single spaces and trims.
 */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// ────────────────────────────────────────────────────────────
// Levenshtein distance (generic)
// ────────────────────────────────────────────────────────────

/**
 * Compute the Levenshtein edit distance between two sequences.
 * Standard dynamic programming approach, O(n*m) time and O(min(n,m)) space.
 *
 * Generic over string characters or word arrays.
 */
export function levenshteinDistance<T>(a: readonly T[], b: readonly T[]): number {
	// Optimize: use the shorter array as the "column" dimension
	if (a.length > b.length) {
		return levenshteinDistance(b, a);
	}

	const aLen = a.length;
	const bLen = b.length;

	// Single-row DP: previous[j] = distance(a[0..i-1], b[0..j])
	let previous = new Array<number>(aLen + 1);
	let current = new Array<number>(aLen + 1);

	// Base case: distance from empty string to a[0..j]
	for (let j = 0; j <= aLen; j++) {
		previous[j] = j;
	}

	for (let i = 1; i <= bLen; i++) {
		current[0] = i;
		for (let j = 1; j <= aLen; j++) {
			const cost = a[j - 1] === b[i - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1] + 1, // insertion
				previous[j] + 1, // deletion
				previous[j - 1] + cost, // substitution
			);
		}
		// Swap rows
		[previous, current] = [current, previous];
	}

	return previous[aLen];
}

// ────────────────────────────────────────────────────────────
// CER / WER
// ────────────────────────────────────────────────────────────

/**
 * Compute Character Error Rate (CER).
 *
 * CER = Levenshtein distance at character level / max(len(expected), 1)
 *
 * @returns 0.0 for perfect match, up to 1.0+ for completely wrong
 */
export function computeCER(expected: string, actual: string): number {
	const normExpected = normalizeWhitespace(expected);
	const normActual = normalizeWhitespace(actual);

	if (normExpected.length === 0 && normActual.length === 0) {
		return 0;
	}

	const expectedChars = [...normExpected];
	const actualChars = [...normActual];

	const distance = levenshteinDistance(expectedChars, actualChars);
	return distance / Math.max(expectedChars.length, 1);
}

/**
 * Compute Word Error Rate (WER).
 *
 * WER = Levenshtein distance at word level / max(wordCount(expected), 1)
 *
 * @returns 0.0 for perfect match, up to 1.0+ for completely wrong
 */
export function computeWER(expected: string, actual: string): number {
	const normExpected = normalizeWhitespace(expected);
	const normActual = normalizeWhitespace(actual);

	if (normExpected.length === 0 && normActual.length === 0) {
		return 0;
	}

	const expectedWords = normExpected.length > 0 ? normExpected.split(' ') : [];
	const actualWords = normActual.length > 0 ? normActual.split(' ') : [];

	const distance = levenshteinDistance(expectedWords, actualWords);
	return distance / Math.max(expectedWords.length, 1);
}
