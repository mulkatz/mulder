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
	searchByVectorWithEfSearch,
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
	countEntitiesByType,
	createEntity,
	deleteEntitiesBySourceId,
	deleteEntity,
	findAllEntities,
	findCandidatesByAttributes,
	findCandidatesByEmbedding,
	findEntitiesByCanonicalId,
	findEntitiesByType,
	findEntityById,
	mergeEntities,
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
	EntityGrounding,
	GroundingCoordinates,
	LinkStoryEntityInput,
	MergeEntitiesResult,
	StoryEntity,
	StoryEntityWithEntity,
	StoryEntityWithStory,
	TaxonomyStatus,
	UpdateEntityInput,
	UpsertEntityGroundingInput,
} from './entity.types.js';
export {
	createEntityAlias,
	deleteAliasesByEntityId,
	deleteEntityAlias,
	findAliasesByEntityId,
	findEntityByAlias,
} from './entity-alias.repository.js';
export {
	applyGroundingToEntity,
	findEntityGroundingByEntityId,
	persistEntityGroundingResult,
	upsertEntityGrounding,
} from './entity-grounding.repository.js';
export type { CreateEvidenceChainInput, EvidenceChain } from './evidence-chain.repository.js';
export {
	createEvidenceChains,
	deleteEvidenceChainsByThesis,
	findEvidenceChainsByThesis,
} from './evidence-chain.repository.js';
export type { GraphTraversalResult } from './graph-traversal.repository.js';
export { traverseGraph } from './graph-traversal.repository.js';
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
	countSourcesByStatus,
	createSource,
	deleteSource,
	deleteSourceStep,
	findAllSources,
	findSourceByHash,
	findSourceById,
	findSourceStep,
	findSourceSteps,
	findSourcesWithFailedSteps,
	updateSource,
	updateSourceStatus,
	upsertSourceStep,
} from './source.repository.js';
export type {
	CreateSourceInput,
	FailedSourceInfo,
	Source,
	SourceFilter,
	SourceStatus,
	SourceStep,
	SourceStepStatus,
	UpdateSourceInput,
	UpsertSourceStepInput,
} from './source.types.js';
export type {
	ClusterableEntityEvent,
	CreateSpatioTemporalClusterInput,
	SpatialEntityEventPair,
	SpatioTemporalCluster,
	SpatioTemporalClusterType,
} from './spatio-temporal-cluster.repository.js';
export {
	createSpatioTemporalClusters,
	deleteAllSpatioTemporalClusters,
	findSpatialEntityEventPairs,
	loadClusterableEntityEvents,
	replaceSpatioTemporalClustersSnapshot,
} from './spatio-temporal-cluster.repository.js';
export {
	countStories,
	countStoriesByStatus,
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
export type { ApplyTaxonomyChangesInput } from './taxonomy.repository.js';
export {
	applyTaxonomyChanges,
	countProcessedSources,
	countTaxonomyEntries,
	createTaxonomyEntry,
	deleteAutoTaxonomyEntries,
	deleteTaxonomyEntry,
	findAllTaxonomyEntries,
	findAllTaxonomyEntriesUnpaginated,
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
