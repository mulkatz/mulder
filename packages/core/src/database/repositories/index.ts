/**
 * Repository barrel export.
 *
 * @see docs/specs/14_source_repository.spec.md §4.4
 * @see docs/specs/22_story_repository.spec.md §4.2
 * @see docs/specs/24_entity_alias_repositories.spec.md §4.6
 * @see docs/specs/25_edge_repository.spec.md §4.4
 * @see docs/specs/27_taxonomy_normalization.spec.md §4.5
 * @see docs/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.spec.md §4.5
 */

export {
	countChunks,
	createChunk,
	createChunks,
	deleteChunksBySourceId,
	deleteChunksByStoryId,
	findChunkById,
	findChunksBySourceId,
	findChunksByStoryId,
	searchByFts,
	searchByVector,
	updateChunkEmbedding,
} from './chunk.repository.js';
export type {
	Chunk,
	ChunkFilter,
	ChunkRow,
	CreateChunkInput,
	FtsSearchResult,
	VectorSearchResult,
} from './chunk.types.js';
export {
	countEdges,
	createEdge,
	deleteEdge,
	deleteEdgesBySourceId,
	deleteEdgesByStoryId,
	findAllEdges,
	findEdgeById,
	findEdgesBetweenEntities,
	findEdgesByEntityId,
	findEdgesBySourceEntityId,
	findEdgesByStoryId,
	findEdgesByTargetEntityId,
	findEdgesByType,
	updateEdge,
	upsertEdge,
} from './edge.repository.js';
export type {
	CreateEdgeInput,
	EdgeFilter,
	EdgeType,
	EntityEdge,
	UpdateEdgeInput,
} from './edge.types.js';
export type { AttributeCandidate, EmbeddingCandidate } from './entity.repository.js';
export {
	countEntities,
	createEntity,
	deleteEntitiesBySourceId,
	deleteEntity,
	findAllEntities,
	findCandidatesByAttributes,
	findCandidatesByEmbedding,
	findEntitiesByCanonicalId,
	findEntitiesByType,
	findEntityById,
	updateEntity,
	updateEntityEmbedding,
	upsertEntityByNameType,
} from './entity.repository.js';
export type {
	CreateEntityAliasInput,
	CreateEntityInput,
	Entity,
	EntityAlias,
	EntityFilter,
	LinkStoryEntityInput,
	StoryEntity,
	StoryEntityWithEntity,
	StoryEntityWithStory,
	TaxonomyStatus,
	UpdateEntityInput,
} from './entity.types.js';
export {
	createEntityAlias,
	deleteAliasesByEntityId,
	deleteEntityAlias,
	findAliasesByEntityId,
	findEntityByAlias,
} from './entity-alias.repository.js';
export type { PipelineStep } from './pipeline-reset.js';
export { gcOrphanedEntities, resetPipelineStep } from './pipeline-reset.js';
export {
	countPipelineRunSourcesByStatus,
	createPipelineRun,
	finalizePipelineRun,
	findLatestPipelineRun,
	findLatestPipelineRunSourceForSource,
	findPipelineRunById,
	findPipelineRunSourceById,
	findPipelineRunSourcesByRunId,
	upsertPipelineRunSource,
} from './pipeline-run.repository.js';
export type {
	CreatePipelineRunInput,
	PipelineRun,
	PipelineRunSource,
	PipelineRunSourceStatus,
	PipelineRunStatus,
	UpsertPipelineRunSourceInput,
} from './pipeline-run.types.js';
export {
	countSources,
	createSource,
	deleteSource,
	deleteSourceStep,
	findAllSources,
	findSourceByHash,
	findSourceById,
	findSourceStep,
	findSourceSteps,
	updateSource,
	updateSourceStatus,
	upsertSourceStep,
} from './source.repository.js';
export type {
	CreateSourceInput,
	Source,
	SourceFilter,
	SourceStatus,
	SourceStep,
	SourceStepStatus,
	UpdateSourceInput,
	UpsertSourceStepInput,
} from './source.types.js';
export {
	countStories,
	createStory,
	deleteStoriesBySourceId,
	deleteStory,
	findAllStories,
	findStoriesBySourceId,
	findStoryById,
	updateStory,
	updateStoryStatus,
} from './story.repository.js';
export type {
	CreateStoryInput,
	Story,
	StoryFilter,
	StoryStatus,
	UpdateStoryInput,
} from './story.types.js';
export {
	deleteStoryEntitiesBySourceId,
	deleteStoryEntitiesByStoryId,
	findEntitiesByStoryId,
	findStoriesByEntityId,
	linkStoryEntity,
	unlinkStoryEntity,
} from './story-entity.repository.js';
export {
	countTaxonomyEntries,
	createTaxonomyEntry,
	deleteTaxonomyEntry,
	findAllTaxonomyEntries,
	findTaxonomyEntryById,
	findTaxonomyEntryByName,
	searchTaxonomyBySimilarity,
	updateTaxonomyEntry,
} from './taxonomy.repository.js';
export type {
	CreateTaxonomyEntryInput,
	NormalizationResult,
	TaxonomyEntry,
	TaxonomyEntryStatus,
	TaxonomyFilter,
	TaxonomySimilarityMatch,
	UpdateTaxonomyEntryInput,
} from './taxonomy.types.js';
