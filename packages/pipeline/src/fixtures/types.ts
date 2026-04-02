/**
 * Types for fixture generation.
 *
 * Defines the input, output, and intermediate types for the
 * `mulder fixtures generate` command that captures real GCP API
 * responses as committed fixtures.
 *
 * @see docs/specs/20_fixture_generator.spec.md §4.3
 * @see docs/functional-spec.md §11
 */

// ────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────

/** Input options for fixture generation. */
export interface FixtureGenerateInput {
	/** Source PDF directory (default: fixtures/raw). */
	inputDir: string;
	/** Output fixtures directory (default: fixtures). */
	outputDir: string;
	/** Regenerate all fixtures even if they already exist. */
	force: boolean;
	/** Only run a specific pipeline step (e.g., 'extract'). */
	step?: string;
}

// ────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────

/** Result from a fixture generation run. */
export interface FixtureGenerateResult {
	/** Overall status of the generation run. */
	status: 'success' | 'partial' | 'failed';
	/** Artifacts that were successfully generated. */
	generated: FixtureArtifact[];
	/** Source slugs that were skipped (already have fixtures). */
	skipped: string[];
	/** Errors encountered during generation. */
	errors: FixtureError[];
}

/** A single generated fixture artifact. */
export interface FixtureArtifact {
	/** Source slug (derived from PDF filename). */
	sourceSlug: string;
	/** Pipeline step that generated this artifact. */
	step: string;
	/** File paths of generated artifacts (relative to output dir). */
	paths: string[];
}

/** An error encountered during fixture generation. */
export interface FixtureError {
	/** Source slug that failed. */
	sourceSlug: string;
	/** Pipeline step that failed. */
	step: string;
	/** Error message. */
	message: string;
}

// ────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────

/** Status of fixtures for a single source. */
export interface FixtureSourceStatus {
	/** Source slug (derived from PDF filename). */
	slug: string;
	/** Whether extracted fixtures exist. */
	hasExtracted: boolean;
	/** Whether segment fixtures exist. */
	hasSegments: boolean;
	/** Whether entity fixtures exist. */
	hasEntities: boolean;
	/** Whether embedding fixtures exist. */
	hasEmbeddings: boolean;
	/** Whether grounding fixtures exist. */
	hasGrounding: boolean;
	/** Last modified date of the source PDF. */
	pdfModified: Date;
	/** Last modified date of the extracted fixtures (null if missing). */
	extractedModified: Date | null;
	/** Whether the fixture is older than the source PDF. */
	isStale: boolean;
}
