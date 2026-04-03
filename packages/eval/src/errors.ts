/**
 * Custom error classes for the eval package.
 *
 * @see docs/specs/21_golden_test_set_extraction.spec.md
 */

import { MulderError } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Error codes
// ────────────────────────────────────────────────────────────

export const EVAL_ERROR_CODES = {
	/** Golden annotation file failed validation. */
	GOLDEN_INVALID: 'EVAL_GOLDEN_INVALID',
	/** Referenced fixture file not found. */
	FIXTURE_NOT_FOUND: 'EVAL_FIXTURE_NOT_FOUND',
	/** Layout JSON parse or structure error. */
	LAYOUT_PARSE_ERROR: 'EVAL_LAYOUT_PARSE_ERROR',
	/** Page referenced in golden annotation not found in layout. */
	PAGE_NOT_FOUND: 'EVAL_PAGE_NOT_FOUND',
	/** Golden directory does not exist or is empty. */
	GOLDEN_DIR_EMPTY: 'EVAL_GOLDEN_DIR_EMPTY',
	/** Segment metadata parse or structure error. */
	SEGMENT_META_PARSE_ERROR: 'EVAL_SEGMENT_META_PARSE_ERROR',
	/** Entity fixture parse or structure error. */
	ENTITY_FIXTURE_PARSE_ERROR: 'EVAL_ENTITY_FIXTURE_PARSE_ERROR',
} as const;

export type EvalErrorCode = (typeof EVAL_ERROR_CODES)[keyof typeof EVAL_ERROR_CODES];

// ────────────────────────────────────────────────────────────
// Error class
// ────────────────────────────────────────────────────────────

/** Evaluation-specific errors. */
export class MulderEvalError extends MulderError {
	constructor(
		message: string,
		code: EvalErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'MulderEvalError';
	}
}
