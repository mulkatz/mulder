import type { SensitivityLevel, SensitivityMetadata } from '../../shared/sensitivity.js';
import type { ArtifactProvenance, ArtifactProvenanceInput } from './artifact-provenance.js';
import type { ClassificationCategoryRef } from './classification-harmonization.types.js';

export type TemporalAnomalyType = 'frequency_spike' | 'frequency_changepoint';
export type SpatiotemporalHotspotType = 'density_cluster';
export type ExternalCorrelationMethod = 'spearman' | 'cross_correlation';
export type TemporalPatternSignalStrength = 'weak';
export type TemporalPatternReviewStatus = 'pending' | 'approved' | 'rejected' | 'contested';
export type HotspotPersistence = 'transient' | 'recurring' | 'permanent';

export interface TemporalPatternEntityEvent {
	entityId: string;
	isoDate: string | null;
	latitude: number | null;
	longitude: number | null;
	attributes: Record<string, unknown>;
	categoryRefs: ClassificationCategoryRef[];
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
}

export interface TemporalAnomalyCluster {
	id: string;
	regionKey: string;
	regionGeojson: Record<string, unknown> | null;
	anomalyType: TemporalAnomalyType;
	timeStart: Date;
	timeEnd: Date;
	entityCount: number;
	baselineRate: number;
	observedRate: number;
	rawSignificance: number;
	comparisonCount: number;
	correctedSignificance: number;
	significanceThreshold: number;
	peakDate: Date;
	dominantCategoryRef: ClassificationCategoryRef | null;
	contributingEntityIds: string[];
	knownPatternMatch: string | null;
	biasWarning: string | null;
	signalStrength: TemporalPatternSignalStrength;
	caveats: string[];
	reviewStatus: TemporalPatternReviewStatus;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	computedAt: Date;
	deletedAt: Date | null;
}

export interface SpatiotemporalHotspotCluster {
	id: string;
	regionKey: string;
	hotspotType: SpatiotemporalHotspotType;
	centroidLat: number;
	centroidLng: number;
	radiusKm: number;
	timeStart: Date;
	timeEnd: Date;
	entityCount: number;
	density: number;
	persistence: HotspotPersistence;
	recurrencePattern: string | null;
	relatedClusterIds: string[];
	contributingEntityIds: string[];
	dominantCategoryRef: ClassificationCategoryRef | null;
	biasWarning: string | null;
	signalStrength: TemporalPatternSignalStrength;
	caveats: string[];
	reviewStatus: TemporalPatternReviewStatus;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	computedAt: Date;
	deletedAt: Date | null;
}

export interface ExternalCorrelation {
	id: string;
	internalSeriesKey: string;
	externalSourceId: string;
	externalSeriesId: string;
	method: ExternalCorrelationMethod;
	coefficient: number;
	pValue: number;
	lagDays: number;
	timeStart: Date;
	timeEnd: Date;
	dataPointCount: number;
	contributingEntityIds: string[];
	interpretationCaveat: string;
	signalStrength: TemporalPatternSignalStrength;
	caveats: string[];
	reviewStatus: TemporalPatternReviewStatus;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	computedAt: Date;
	deletedAt: Date | null;
}

export interface CreateTemporalAnomalyClusterInput {
	id?: string;
	regionKey: string;
	regionGeojson?: Record<string, unknown> | null;
	anomalyType?: TemporalAnomalyType;
	timeStart: Date;
	timeEnd: Date;
	entityCount: number;
	baselineRate: number;
	observedRate: number;
	rawSignificance: number;
	comparisonCount: number;
	correctedSignificance: number;
	significanceThreshold: number;
	peakDate: Date;
	dominantCategoryRef?: ClassificationCategoryRef | null;
	contributingEntityIds: string[];
	knownPatternMatch?: string | null;
	biasWarning?: string | null;
	caveats?: string[];
	reviewStatus?: TemporalPatternReviewStatus;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
	computedAt?: Date;
}

export interface CreateSpatiotemporalHotspotClusterInput {
	id?: string;
	regionKey: string;
	hotspotType?: SpatiotemporalHotspotType;
	centroidLat: number;
	centroidLng: number;
	radiusKm: number;
	timeStart: Date;
	timeEnd: Date;
	entityCount: number;
	density: number;
	persistence: HotspotPersistence;
	recurrencePattern?: string | null;
	relatedClusterIds?: string[];
	contributingEntityIds: string[];
	dominantCategoryRef?: ClassificationCategoryRef | null;
	biasWarning?: string | null;
	caveats?: string[];
	reviewStatus?: TemporalPatternReviewStatus;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
	computedAt?: Date;
}

export interface CreateExternalCorrelationInput {
	id?: string;
	internalSeriesKey: string;
	externalSourceId: string;
	externalSeriesId: string;
	method: ExternalCorrelationMethod;
	coefficient: number;
	pValue: number;
	lagDays: number;
	timeStart: Date;
	timeEnd: Date;
	dataPointCount: number;
	contributingEntityIds: string[];
	interpretationCaveat?: string;
	caveats?: string[];
	reviewStatus?: TemporalPatternReviewStatus;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
	computedAt?: Date;
}

export interface ReplaceTemporalPatternSnapshotInput {
	anomalies: CreateTemporalAnomalyClusterInput[];
	hotspots: CreateSpatiotemporalHotspotClusterInput[];
}

export interface ReplaceTemporalPatternSnapshotResult {
	anomalies: TemporalAnomalyCluster[];
	hotspots: SpatiotemporalHotspotCluster[];
}

export interface ReplaceExternalCorrelationSnapshotInput {
	correlations: CreateExternalCorrelationInput[];
}

export interface ReplaceExternalCorrelationSnapshotResult {
	correlations: ExternalCorrelation[];
}

export interface TemporalPatternListOptions {
	regionKey?: string;
	timeStart?: Date;
	timeEnd?: Date;
	reviewStatus?: TemporalPatternReviewStatus | readonly TemporalPatternReviewStatus[];
	signalStrength?: TemporalPatternSignalStrength;
	includeDeleted?: boolean;
	maxSensitivityLevel?: SensitivityLevel;
	limit?: number;
	offset?: number;
}

export interface TemporalAnomalyClusterListOptions extends TemporalPatternListOptions {
	anomalyType?: TemporalAnomalyType;
}

export interface SpatiotemporalHotspotClusterListOptions extends TemporalPatternListOptions {
	hotspotType?: SpatiotemporalHotspotType;
	persistence?: HotspotPersistence | readonly HotspotPersistence[];
}

export interface ExternalCorrelationListOptions extends Omit<TemporalPatternListOptions, 'regionKey'> {
	internalSeriesKey?: string;
	externalSourceId?: string;
	externalSeriesId?: string;
	method?: ExternalCorrelationMethod | readonly ExternalCorrelationMethod[];
}

export interface TemporalPatternFindOptions {
	includeDeleted?: boolean;
	maxSensitivityLevel?: SensitivityLevel;
}
