/**
 * Zod schema for Gemini segmentation structured output.
 *
 * Defines the expected response shape from Gemini when segmenting
 * a document into individual stories. The schema is converted to
 * JSON Schema via `zod-to-json-schema` for Gemini's server-side
 * enforcement.
 *
 * Note: `zod-to-json-schema` expects Zod v3-compatible schemas
 * (via `zod/v3`), while runtime validation uses the native Zod v4
 * import. Both schemas are defined here with identical shapes.
 *
 * @see docs/specs/23_segment_step.spec.md §4.4
 * @see docs/functional-spec.md §2.3
 */

import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ────────────────────────────────────────────────────────────
// Zod v3 schema (for JSON Schema generation via zod-to-json-schema)
// ────────────────────────────────────────────────────────────

const segmentedStorySchemaV3 = z3.object({
	title: z3.string().describe('The title of the article/story'),
	subtitle: z3.string().nullable().describe('Subtitle if present, null otherwise'),
	language: z3.string().describe('ISO 639-1 language code (e.g., "de", "en")'),
	category: z3.string().describe('Category of the story (e.g., "sighting_report", "editorial", "news")'),
	page_start: z3.number().int().describe('First page number (1-indexed) where this story appears'),
	page_end: z3.number().int().describe('Last page number (1-indexed) where this story ends'),
	date_references: z3.array(z3.string()).describe('ISO 8601 dates mentioned in the story'),
	geographic_references: z3.array(z3.string()).describe('Place names mentioned in the story'),
	confidence: z3.number().min(0).max(1).describe('Confidence in story boundary identification (0-1)'),
	content_markdown: z3
		.string()
		.describe('Full story text in Markdown format with headings, paragraphs, and formatting preserved'),
});

const segmentationResponseSchemaV3 = z3.object({
	stories: z3.array(segmentedStorySchemaV3).describe('All identified stories/articles in the document'),
});

// ────────────────────────────────────────────────────────────
// Zod v4 schema (for runtime validation)
// ────────────────────────────────────────────────────────────

/** Schema for a single story identified by Gemini. */
export const segmentedStorySchema = z.object({
	title: z.string(),
	subtitle: z.nullable(z.string()),
	language: z.string(),
	category: z.string(),
	page_start: z.number().int(),
	page_end: z.number().int(),
	date_references: z.array(z.string()),
	geographic_references: z.array(z.string()),
	confidence: z.number().min(0).max(1),
	content_markdown: z.string(),
});

/** Schema for the full segmentation response from Gemini. */
export const segmentationResponseSchema = z.object({
	stories: z.array(segmentedStorySchema),
});

/** Inferred TypeScript type for the segmentation response. */
export type SegmentationResponse = z.infer<typeof segmentationResponseSchema>;

/**
 * Generates a JSON Schema from the Zod segmentation response schema.
 *
 * Uses the Zod v3-compatible schema since `zod-to-json-schema` requires it.
 * Uses `$refStrategy: 'none'` to produce a flat, self-contained schema
 * that Gemini can enforce server-side without `$ref` resolution.
 */
export function getSegmentationJsonSchema(): Record<string, unknown> {
	const schema: Record<string, unknown> = zodToJsonSchema(segmentationResponseSchemaV3, {
		$refStrategy: 'none',
	});
	return schema;
}
