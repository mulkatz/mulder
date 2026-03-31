/**
 * Shared TypeScript types for the Mulder platform.
 *
 * Cross-cutting types used by multiple packages (pipeline steps, CLI, API).
 *
 * @see docs/specs/16_ingest_step.spec.md §4.6
 * @see docs/functional-spec.md §2
 */

// ────────────────────────────────────────────────────────────
// Pipeline step error
// ────────────────────────────────────────────────────────────

/** Per-item error reported by pipeline steps. */
export interface StepError {
	/** File path or identifier of the item that failed. */
	file?: string;
	/** Error code from the domain error hierarchy. */
	code: string;
	/** Human-readable error message. */
	message: string;
}
