/**
 * Enrich module barrel exports.
 *
 * Exports the JSON Schema generator and runtime validation schema
 * for entity extraction structured output.
 *
 * @see docs/specs/26_json_schema_generator.spec.md
 */

export {
	generateExtractionSchema,
	getEntityTypeNames,
	getExtractionResponseSchema,
} from './schema.js';
