/**
 * Enrich module barrel exports.
 *
 * Exports the JSON Schema generator, runtime validation schema,
 * and cross-lingual entity resolution module.
 *
 * @see docs/specs/26_json_schema_generator.spec.md
 * @see docs/specs/28_cross_lingual_entity_resolution.spec.md
 */

export { resolveEntity } from './resolution.js';
export type {
	ResolutionCandidate,
	ResolutionResult,
	ResolutionTier,
	ResolveEntityOptions,
} from './resolution-types.js';
export {
	generateExtractionSchema,
	getEntityTypeNames,
	getExtractionResponseSchema,
} from './schema.js';
