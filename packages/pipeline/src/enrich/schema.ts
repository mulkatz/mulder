/**
 * Dynamic JSON Schema generator for Gemini entity extraction structured output.
 *
 * Reads the user's ontology definition from config (entity types, attributes,
 * relationships) and produces a JSON Schema that Gemini enforces server-side.
 *
 * Uses the dual-schema pattern established in segment/schema.ts:
 * - Zod v3 schemas for JSON Schema generation (zod-to-json-schema requires v3)
 * - Zod v4 schemas for runtime validation of Gemini responses
 *
 * @see docs/specs/26_json_schema_generator.spec.md
 * @see docs/functional-spec.md §2.4
 */

import type { EntityTypeConfig, OntologyConfig } from '@mulder/core';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ────────────────────────────────────────────────────────────
// Attribute type mapping helpers
// ────────────────────────────────────────────────────────────

type AttributeType = 'string' | 'number' | 'boolean' | 'date' | 'geo_point' | 'string[]';

/**
 * Maps a config attribute type to a Zod v3 schema for JSON Schema generation.
 */
function attributeToZod3(type: AttributeType): z3.ZodTypeAny {
	switch (type) {
		case 'string':
			return z3.string();
		case 'number':
			return z3.number();
		case 'boolean':
			return z3.boolean();
		case 'date':
			return z3.string().describe('ISO 8601 date');
		case 'geo_point':
			return z3.object({ lat: z3.number(), lng: z3.number() });
		case 'string[]':
			return z3.array(z3.string());
	}
}

/**
 * Maps a config attribute type to a Zod v4 schema for runtime validation.
 */
function attributeToZod4(type: AttributeType): z.ZodType {
	switch (type) {
		case 'string':
			return z.string();
		case 'number':
			return z.number();
		case 'boolean':
			return z.boolean();
		case 'date':
			return z.string();
		case 'geo_point':
			return z.object({ lat: z.number(), lng: z.number() });
		case 'string[]':
			return z.array(z.string());
	}
}

// ────────────────────────────────────────────────────────────
// Entity type names utility
// ────────────────────────────────────────────────────────────

/**
 * Extracts entity type names from the ontology config, sorted alphabetically.
 * Useful for building enum constraints and for display purposes.
 */
export function getEntityTypeNames(ontology: OntologyConfig): string[] {
	return ontology.entity_types.map((et) => et.name).sort();
}

// ────────────────────────────────────────────────────────────
// Attributes union builder
// ────────────────────────────────────────────────────────────

/**
 * Collects all unique attributes across all entity types into a flat union.
 * When the same attribute name appears in multiple entity types, the first
 * occurrence's type wins (they should be consistent per config validation).
 */
function collectAllAttributes(entityTypes: readonly EntityTypeConfig[]): Map<string, AttributeType> {
	const attributes = new Map<string, AttributeType>();
	for (const entityType of entityTypes) {
		for (const attr of entityType.attributes) {
			if (!attributes.has(attr.name)) {
				attributes.set(attr.name, attr.type);
			}
		}
	}
	return attributes;
}

// ────────────────────────────────────────────────────────────
// Zod v3 schema builders (for JSON Schema generation)
// ────────────────────────────────────────────────────────────

/**
 * Builds the Zod v3 attributes object schema from a flat union of all
 * entity type attributes. All properties are optional since different
 * entity types use different attribute subsets.
 */
function buildAttributesSchemaV3(entityTypes: readonly EntityTypeConfig[]): z3.ZodObject<z3.ZodRawShape> {
	const allAttributes = collectAllAttributes(entityTypes);
	const shape: z3.ZodRawShape = {};

	for (const [name, type] of allAttributes) {
		shape[name] = attributeToZod3(type).optional();
	}

	return z3.object(shape);
}

/**
 * Builds the full extraction response Zod v3 schema for JSON Schema generation.
 */
function buildExtractionResponseSchemaV3(ontology: OntologyConfig): z3.ZodObject<z3.ZodRawShape> {
	const entityTypeNames = getEntityTypeNames(ontology);
	const relationshipNames = ontology.relationships.map((r) => r.name).sort();

	const attributesSchema = buildAttributesSchemaV3(ontology.entity_types);

	// Entity schema
	const entitySchemaV3 = z3.object({
		name: z3.string().describe('The canonical name of the entity'),
		type: z3.enum(entityTypeNames as [string, ...string[]]).describe('The entity type from the ontology'),
		confidence: z3.number().min(0).max(1).describe('Confidence score for entity extraction (0-1)'),
		attributes: attributesSchema.describe('Entity attributes based on its type'),
		mentions: z3.array(z3.string()).describe('All text mentions/aliases of this entity in the story'),
	});

	// Relationship schema
	const relationshipSchemaV3 = z3.object({
		source_entity: z3.string().describe('Name of the source entity'),
		target_entity: z3.string().describe('Name of the target entity'),
		relationship_type:
			relationshipNames.length > 0
				? z3.enum(relationshipNames as [string, ...string[]]).describe('Relationship type from the ontology')
				: z3.string().describe('Relationship type'),
		confidence: z3.number().min(0).max(1).describe('Confidence score for relationship extraction (0-1)'),
		attributes: z3.object({}).passthrough().optional().describe('Optional relationship attributes'),
	});

	return z3.object({
		entities: z3.array(entitySchemaV3).describe('All entities extracted from the story'),
		relationships: z3.array(relationshipSchemaV3).describe('All relationships between extracted entities'),
	});
}

// ────────────────────────────────────────────────────────────
// Zod v4 schema builders (for runtime validation)
// ────────────────────────────────────────────────────────────

/**
 * Builds the Zod v4 attributes object schema from a flat union of all
 * entity type attributes. All properties are optional.
 */
function buildAttributesSchemaV4(entityTypes: readonly EntityTypeConfig[]) {
	const allAttributes = collectAllAttributes(entityTypes);
	const shape: Record<string, z.ZodType> = {};

	for (const [name, type] of allAttributes) {
		shape[name] = z.optional(attributeToZod4(type));
	}

	return z.object(shape);
}

/**
 * Builds the full extraction response Zod v4 schema for runtime validation.
 * Returns a typed schema that can validate Gemini's structured output response.
 */
function buildExtractionResponseSchemaV4(ontology: OntologyConfig) {
	const entityTypeNames = getEntityTypeNames(ontology);
	const relationshipNames = ontology.relationships.map((r) => r.name).sort();

	const attributesSchema = buildAttributesSchemaV4(ontology.entity_types);

	// Entity schema
	const entitySchemaV4 = z.object({
		name: z.string(),
		type: z.enum(entityTypeNames as [string, ...string[]]),
		confidence: z.number().min(0).max(1),
		attributes: attributesSchema,
		mentions: z.array(z.string()),
	});

	// Relationship schema
	const relationshipSchemaV4 = z.object({
		source_entity: z.string(),
		target_entity: z.string(),
		relationship_type: relationshipNames.length > 0 ? z.enum(relationshipNames as [string, ...string[]]) : z.string(),
		confidence: z.number().min(0).max(1),
		attributes: z.optional(z.record(z.string(), z.unknown())),
	});

	return z.object({
		entities: z.array(entitySchemaV4),
		relationships: z.array(relationshipSchemaV4),
	});
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Generates a JSON Schema from the ontology config for Gemini structured output.
 *
 * Uses the Zod v3-compatible schema since `zod-to-json-schema` requires it.
 * Uses `$refStrategy: 'none'` to produce a flat, self-contained schema
 * that Gemini can enforce server-side without `$ref` resolution.
 *
 * The output is deterministic: same ontology config always produces
 * identical JSON Schema (entity types and relationship types are sorted
 * alphabetically in their enum values).
 */
export function generateExtractionSchema(ontology: OntologyConfig): Record<string, unknown> {
	const schemaV3 = buildExtractionResponseSchemaV3(ontology);
	const schema: Record<string, unknown> = zodToJsonSchema(schemaV3, {
		$refStrategy: 'none',
	});
	return schema;
}

/**
 * Returns the Zod v4 schema for runtime validation of Gemini extraction responses.
 *
 * Use this to validate Gemini's structured output before writing to the database.
 * The schema is dynamically built from the ontology config, so it matches
 * the JSON Schema sent to Gemini.
 */
export function getExtractionResponseSchema(ontology: OntologyConfig): z.ZodType {
	return buildExtractionResponseSchemaV4(ontology);
}
