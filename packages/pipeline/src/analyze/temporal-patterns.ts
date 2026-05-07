import { createHash } from 'node:crypto';
import type {
	ArtifactProvenanceInput,
	ClassificationCategoryRef,
	CreateExternalCorrelationInput,
	CreateSpatiotemporalHotspotClusterInput,
	CreateTemporalAnomalyClusterInput,
	ExternalCorrelationMethod,
	HotspotPersistence,
	MulderConfig,
	SensitivityLevel,
	SensitivityMetadata,
	TemporalPatternEntityEvent,
	TemporalPatternKnownPatternConfig,
	TemporalPatternRegionGridConfig,
} from '@mulder/core';
import {
	loadTemporalPatternEntityEvents,
	mergeSensitivityMetadata,
	mostRestrictiveSensitivityLevel,
	replaceExternalCorrelationSnapshot,
	replaceTemporalPatternSnapshot,
} from '@mulder/core';
import type pg from 'pg';
import type { ExternalDataFetchResult, ExternalDataPoint, ExternalDataSourceRegistry } from './external-correlation.js';
import { getExternalDataSourceRegistry } from './external-correlation.js';
import type {
	ExternalCorrelationSummary,
	TemporalPatternAnalyzeData,
	TemporalPatternAnomalySummary,
	TemporalPatternDetectionResult,
	TemporalPatternHotspotSummary,
} from './types.js';

const WEAK_SIGNAL_CAVEAT = 'Patterns are hypothesis starters, not causal evidence.';
const CORRELATION_CAVEAT = 'Correlation ≠ Causation';
const EARTH_RADIUS_KM = 6371;
const DAY_MS = 24 * 60 * 60 * 1000;

interface NormalizedEvent {
	entityId: string;
	occurredAt: Date;
	latitude: number | null;
	longitude: number | null;
	attributes: Record<string, unknown>;
	categoryRefs: ClassificationCategoryRef[];
	provenance: ArtifactProvenanceInput;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
}

interface RegionEvent extends NormalizedEvent {
	regionKey: string;
	regionGeojson: Record<string, unknown> | null;
}

interface BucketedRegionEvents {
	regionKey: string;
	regionGeojson: Record<string, unknown> | null;
	events: RegionEvent[];
	buckets: Map<number, RegionEvent[]>;
}

interface AnomalyCandidate {
	input: CreateTemporalAnomalyClusterInput;
	summary: TemporalPatternAnomalySummary;
	rawSignificance: number;
}

interface HotspotCandidate {
	id: string;
	groupKey: string;
	bucketKey: number;
	centroidLat: number;
	centroidLng: number;
	timeStart: Date;
	timeEnd: Date;
	events: NormalizedEvent[];
}

interface HotspotInputWithSummary {
	input: CreateSpatiotemporalHotspotClusterInput;
	summary: TemporalPatternHotspotSummary;
}

interface InternalCorrelationBucket {
	value: number;
	events: NormalizedEvent[];
}

interface InternalCorrelationSeries {
	key: string;
	points: Map<string, InternalCorrelationBucket>;
	events: NormalizedEvent[];
}

interface AlignedCorrelationPoint {
	internalValue: number;
	externalValue: number;
	dateKey: string;
	events: NormalizedEvent[];
}

interface CorrelationComputation {
	method: ExternalCorrelationMethod;
	coefficient: number;
	pValue: number;
	lagDays: number;
	timeStart: Date;
	timeEnd: Date;
	dataPointCount: number;
	events: NormalizedEvent[];
}

interface ExternalCorrelationBuildResult {
	inputs: CreateExternalCorrelationInput[];
	summaries: ExternalCorrelationSummary[];
	warnings: string[];
	evaluatedSeriesCount: number;
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string') return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoDate(value: string | null): Date | null {
	const trimmed = value?.trim() ?? '';
	if (trimmed.length === 0) return null;
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
	const timestamp = Date.parse(normalized);
	if (Number.isNaN(timestamp)) return null;
	return new Date(timestamp);
}

function normalizeEvent(event: TemporalPatternEntityEvent): NormalizedEvent | null {
	const occurredAt = parseIsoDate(event.isoDate);
	if (!occurredAt) return null;

	return {
		entityId: event.entityId,
		occurredAt,
		latitude: event.latitude,
		longitude: event.longitude,
		attributes: event.attributes,
		categoryRefs: event.categoryRefs,
		provenance: event.provenance,
		sensitivityLevel: event.sensitivityLevel,
		sensitivityMetadata: event.sensitivityMetadata,
	};
}

function startOfUtcDay(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date: Date): Date {
	const dayStart = startOfUtcDay(date);
	const day = dayStart.getUTCDay();
	const delta = day === 0 ? 6 : day - 1;
	return new Date(dayStart.getTime() - delta * DAY_MS);
}

function bucketStart(
	date: Date,
	granularity: MulderConfig['temporal_pattern_detection']['anomaly_detection']['granularity'],
): Date {
	switch (granularity) {
		case 'day':
			return startOfUtcDay(date);
		case 'week':
			return startOfUtcWeek(date);
		case 'month':
			return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
		case 'year':
			return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	}
}

function addBuckets(
	date: Date,
	count: number,
	granularity: MulderConfig['temporal_pattern_detection']['anomaly_detection']['granularity'],
): Date {
	switch (granularity) {
		case 'day':
			return new Date(date.getTime() + count * DAY_MS);
		case 'week':
			return new Date(date.getTime() + count * 7 * DAY_MS);
		case 'month':
			return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
		case 'year':
			return new Date(Date.UTC(date.getUTCFullYear() + count, 0, 1));
	}
}

function bucketCountBetween(
	start: Date,
	end: Date,
	granularity: MulderConfig['temporal_pattern_detection']['anomaly_detection']['granularity'],
): number {
	if (end.getTime() <= start.getTime()) return 0;
	switch (granularity) {
		case 'day':
			return Math.max(0, Math.round((startOfUtcDay(end).getTime() - startOfUtcDay(start).getTime()) / DAY_MS));
		case 'week':
			return Math.max(0, Math.round((startOfUtcWeek(end).getTime() - startOfUtcWeek(start).getTime()) / (7 * DAY_MS)));
		case 'month':
			return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
		case 'year':
			return end.getUTCFullYear() - start.getUTCFullYear();
	}
}

function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function readRegionKey(event: NormalizedEvent, strategy: TemporalPatternRegionGridConfig): string | null {
	switch (strategy) {
		case 'country':
			return readString(
				event.attributes.country ??
					event.attributes.country_code ??
					event.attributes.countryCode ??
					event.attributes.region_country,
			);
		case 'admin1': {
			const admin1 = readString(
				event.attributes.admin1 ?? event.attributes.admin_1 ?? event.attributes.state ?? event.attributes.province,
			);
			if (!admin1) return null;
			const country = readString(
				event.attributes.country ?? event.attributes.country_code ?? event.attributes.countryCode,
			);
			return country ? `${country}:${admin1}` : admin1;
		}
		case 'hex_grid_100km':
			if (event.latitude === null || event.longitude === null) return null;
			return coordinateBucketKey(event.latitude, event.longitude);
	}
}

function coordinateBucketKey(latitude: number, longitude: number): string {
	return `hex_grid_100km:${Math.round(latitude)}:${Math.round(longitude)}`;
}

function regionGeojsonForEvent(event: NormalizedEvent): Record<string, unknown> | null {
	if (event.latitude === null || event.longitude === null) return null;
	return {
		type: 'Point',
		coordinates: [event.longitude, event.latitude],
	};
}

function groupRegionEvents(
	events: NormalizedEvent[],
	config: MulderConfig['temporal_pattern_detection']['anomaly_detection'],
): BucketedRegionEvents[] {
	const groups = new Map<string, BucketedRegionEvents>();

	for (const event of events) {
		const regionKey = readRegionKey(event, config.region_grid);
		if (!regionKey) continue;
		const existing = groups.get(regionKey) ?? {
			regionKey,
			regionGeojson: regionGeojsonForEvent(event),
			events: [],
			buckets: new Map<number, RegionEvent[]>(),
		};
		const regionEvent = {
			...event,
			regionKey,
			regionGeojson: existing.regionGeojson ?? regionGeojsonForEvent(event),
		};
		existing.events.push(regionEvent);
		const key = bucketStart(regionEvent.occurredAt, config.granularity).getTime();
		existing.buckets.set(key, [...(existing.buckets.get(key) ?? []), regionEvent]);
		groups.set(regionKey, existing);
	}

	return [...groups.values()]
		.sort((left, right) => right.events.length - left.events.length || left.regionKey.localeCompare(right.regionKey))
		.slice(0, config.max_regions);
}

function erfApprox(value: number): number {
	const sign = value < 0 ? -1 : 1;
	const x = Math.abs(value);
	const t = 1 / (1 + 0.3275911 * x);
	const y =
		1 -
		((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
	return sign * y;
}

function normalUpperTail(zScore: number): number {
	return Math.max(0, Math.min(1, 0.5 * (1 - erfApprox(zScore / Math.SQRT2))));
}

function poissonUpperTail(observed: number, expected: number): number {
	if (observed <= 0) return 1;
	if (expected <= 0) return 0;
	if (expected > 100 || observed > 180) {
		const zScore = (observed - expected) / Math.sqrt(expected);
		return normalUpperTail(zScore);
	}

	let term = Math.exp(-expected);
	let cdf = term;
	for (let k = 1; k < observed; k++) {
		term *= expected / k;
		cdf += term;
	}
	return Math.max(0, Math.min(1, 1 - cdf));
}

function mergeProvenance(events: readonly NormalizedEvent[]): ArtifactProvenanceInput {
	const sourceIds = new Set<string>();
	for (const event of events) {
		for (const sourceId of event.provenance.sourceDocumentIds ?? []) {
			sourceIds.add(sourceId);
		}
	}
	return {
		sourceDocumentIds: [...sourceIds].sort(),
		extractionPipelineRun: null,
		createdAt: new Date(),
	};
}

function mergeSensitivity(events: readonly NormalizedEvent[]): {
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
} {
	const sensitivityLevel = mostRestrictiveSensitivityLevel(
		events.map((event) => event.sensitivityLevel),
		'internal',
	);
	return {
		sensitivityLevel,
		sensitivityMetadata: mergeSensitivityMetadata(
			events.map((event) => event.sensitivityMetadata),
			sensitivityLevel,
		),
	};
}

function categoryRefKey(ref: ClassificationCategoryRef): string {
	return `${ref.taxonomyId ?? ''}:${ref.categoryId}`;
}

function dominantCategoryRef(events: readonly NormalizedEvent[]): ClassificationCategoryRef | null {
	const counts = new Map<string, { ref: ClassificationCategoryRef; count: number }>();
	for (const event of events) {
		for (const ref of event.categoryRefs) {
			const key = categoryRefKey(ref);
			const existing = counts.get(key);
			counts.set(key, { ref, count: (existing?.count ?? 0) + 1 });
		}
	}

	return (
		[...counts.values()].sort(
			(left, right) =>
				right.count - left.count ||
				(left.ref.taxonomyId ?? '').localeCompare(right.ref.taxonomyId ?? '') ||
				left.ref.categoryId.localeCompare(right.ref.categoryId),
		)[0]?.ref ?? null
	);
}

function reportingBiasWarning(
	events: readonly NormalizedEvent[],
	config: MulderConfig['temporal_pattern_detection']['reporting_bias'],
): string | null {
	if (!config.correction_enabled || !config.correction_field) return null;

	const values = events
		.map((event) => event.attributes[config.correction_field ?? ''])
		.map(readNumber)
		.filter((value): value is number => value !== null);
	if (values.length === 0) return null;

	const average = values.reduce((total, value) => total + value, 0) / values.length;
	if (average < config.elevated_threshold) return null;
	return 'Potential reporting bias: configured observation intensity is elevated for contributing entities.';
}

function knownPatternMatch(
	regionKey: string,
	timeStart: Date,
	timeEnd: Date,
	categoryRef: ClassificationCategoryRef | null,
	patterns: readonly TemporalPatternKnownPatternConfig[],
): string | null {
	for (const pattern of patterns) {
		if (pattern.region_key && pattern.region_key !== regionKey) continue;
		if (pattern.category_ref) {
			if (!categoryRef) continue;
			if (pattern.category_ref.category_id !== categoryRef.categoryId) continue;
			if (pattern.category_ref.taxonomy_id && pattern.category_ref.taxonomy_id !== categoryRef.taxonomyId) continue;
		}
		if (pattern.time_start) {
			const patternStart = parseIsoDate(pattern.time_start);
			if (patternStart && timeEnd.getTime() < patternStart.getTime()) continue;
		}
		if (pattern.time_end) {
			const patternEnd = parseIsoDate(pattern.time_end);
			if (patternEnd && timeStart.getTime() > patternEnd.getTime()) continue;
		}
		return pattern.id;
	}
	return null;
}

function peakDate(
	events: readonly NormalizedEvent[],
	granularity: MulderConfig['temporal_pattern_detection']['anomaly_detection']['granularity'],
): Date {
	const counts = new Map<number, { count: number; firstDate: Date }>();
	for (const event of events) {
		const key = bucketStart(event.occurredAt, granularity).getTime();
		const existing = counts.get(key);
		if (!existing) {
			counts.set(key, { count: 1, firstDate: event.occurredAt });
			continue;
		}
		counts.set(key, {
			count: existing.count + 1,
			firstDate: existing.firstDate.getTime() <= event.occurredAt.getTime() ? existing.firstDate : event.occurredAt,
		});
	}
	return (
		[...counts.values()].sort(
			(left, right) => right.count - left.count || left.firstDate.getTime() - right.firstDate.getTime(),
		)[0]?.firstDate ??
		events[0]?.occurredAt ??
		new Date()
	);
}

function makeAnomalyCandidate(input: {
	group: BucketedRegionEvents;
	observedEvents: RegionEvent[];
	windowStart: Date;
	windowEnd: Date;
	anomalyType: CreateTemporalAnomalyClusterInput['anomalyType'];
	baselineRate: number;
	observedRate: number;
	rawSignificance: number;
	significanceThreshold: number;
	granularity: MulderConfig['temporal_pattern_detection']['anomaly_detection']['granularity'];
	knownPatterns: MulderConfig['temporal_pattern_detection']['anomaly_detection']['known_patterns'];
	reportingBias: MulderConfig['temporal_pattern_detection']['reporting_bias'];
	computedAt: Date;
}): AnomalyCandidate {
	const categoryRef = dominantCategoryRef(input.observedEvents);
	const sensitivity = mergeSensitivity(input.observedEvents);
	const anomalyInput: CreateTemporalAnomalyClusterInput = {
		regionKey: input.group.regionKey,
		regionGeojson: input.group.regionGeojson,
		anomalyType: input.anomalyType,
		timeStart: input.windowStart,
		timeEnd: input.windowEnd,
		entityCount: input.observedEvents.length,
		baselineRate: input.baselineRate,
		observedRate: input.observedRate,
		rawSignificance: input.rawSignificance,
		comparisonCount: 1,
		correctedSignificance: input.rawSignificance,
		significanceThreshold: input.significanceThreshold,
		peakDate: peakDate(input.observedEvents, input.granularity),
		dominantCategoryRef: categoryRef,
		contributingEntityIds: input.observedEvents
			.map((event) => event.entityId)
			.sort((left, right) => left.localeCompare(right)),
		knownPatternMatch: knownPatternMatch(
			input.group.regionKey,
			input.windowStart,
			input.windowEnd,
			categoryRef,
			input.knownPatterns,
		),
		biasWarning: reportingBiasWarning(input.observedEvents, input.reportingBias),
		caveats: [WEAK_SIGNAL_CAVEAT],
		provenance: mergeProvenance(input.observedEvents),
		sensitivityLevel: sensitivity.sensitivityLevel,
		sensitivityMetadata: sensitivity.sensitivityMetadata,
		computedAt: input.computedAt,
	};
	return {
		input: anomalyInput,
		rawSignificance: input.rawSignificance,
		summary: {
			regionKey: input.group.regionKey,
			timeStart: input.windowStart,
			timeEnd: input.windowEnd,
			entityCount: input.observedEvents.length,
			baselineRate: input.baselineRate,
			observedRate: input.observedRate,
			rawSignificance: input.rawSignificance,
			correctedSignificance: input.rawSignificance,
			contributingEntityIds: anomalyInput.contributingEntityIds,
		},
	};
}

function buildAnomalyCandidates(
	events: NormalizedEvent[],
	config: MulderConfig['temporal_pattern_detection'],
	computedAt: Date,
): { candidates: AnomalyCandidate[]; comparisonCount: number; boundedComparisonCount: number } {
	const anomalyConfig = config.anomaly_detection;
	if (!config.enabled || !anomalyConfig.enabled) {
		return { candidates: [], comparisonCount: 0, boundedComparisonCount: 0 };
	}

	const regionGroups = groupRegionEvents(events, anomalyConfig);
	const preliminary: AnomalyCandidate[] = [];
	let comparisonCount = 0;
	let boundedComparisonCount = 0;

	for (const group of regionGroups) {
		const bucketStarts = [...group.buckets.keys()]
			.sort((left, right) => left - right)
			.slice(-anomalyConfig.max_windows);
		for (const bucketKey of bucketStarts) {
			const windowStart = new Date(bucketKey);
			const windowEnd = addBuckets(windowStart, anomalyConfig.window_size_buckets, anomalyConfig.granularity);
			const baselineStart = new Date(
				Date.UTC(
					windowStart.getUTCFullYear() - anomalyConfig.baseline_window_years,
					windowStart.getUTCMonth(),
					windowStart.getUTCDate(),
				),
			);
			const baselineBucketCount = bucketCountBetween(baselineStart, windowStart, anomalyConfig.granularity);
			if (baselineBucketCount <= 0) continue;

			const observedEvents = group.events.filter(
				(event) =>
					event.occurredAt.getTime() >= windowStart.getTime() && event.occurredAt.getTime() < windowEnd.getTime(),
			);
			const baselineEvents = group.events.filter(
				(event) =>
					event.occurredAt.getTime() >= baselineStart.getTime() && event.occurredAt.getTime() < windowStart.getTime(),
			);
			comparisonCount++;
			if (comparisonCount <= anomalyConfig.max_regions * anomalyConfig.max_windows) {
				boundedComparisonCount = comparisonCount;
			}
			if (observedEvents.length < anomalyConfig.min_entities) continue;

			const baselineRate = baselineEvents.length / baselineBucketCount;
			const observedRate = observedEvents.length / anomalyConfig.window_size_buckets;
			const expected = Math.max(0.000001, baselineRate * anomalyConfig.window_size_buckets);
			if (observedRate <= baselineRate) continue;

			const rawSignificance = poissonUpperTail(observedEvents.length, expected);
			preliminary.push(
				makeAnomalyCandidate({
					group,
					observedEvents,
					windowStart,
					windowEnd,
					anomalyType: 'frequency_spike',
					baselineRate,
					observedRate,
					rawSignificance,
					significanceThreshold: anomalyConfig.significance_threshold,
					granularity: anomalyConfig.granularity,
					knownPatterns: anomalyConfig.known_patterns,
					reportingBias: config.reporting_bias,
					computedAt,
				}),
			);
		}
	}

	if (anomalyConfig.changepoint_detection.enabled) {
		const changepointConfig = anomalyConfig.changepoint_detection;
		for (const group of regionGroups) {
			let cusum = 0;
			let consecutiveWindows = 0;
			const bucketStarts = [...group.buckets.keys()]
				.sort((left, right) => left - right)
				.slice(-anomalyConfig.max_windows);
			for (const bucketKey of bucketStarts) {
				const windowStart = new Date(bucketKey);
				const windowEnd = addBuckets(windowStart, anomalyConfig.window_size_buckets, anomalyConfig.granularity);
				const baselineStart = new Date(
					Date.UTC(
						windowStart.getUTCFullYear() - anomalyConfig.baseline_window_years,
						windowStart.getUTCMonth(),
						windowStart.getUTCDate(),
					),
				);
				const baselineBucketCount = bucketCountBetween(baselineStart, windowStart, anomalyConfig.granularity);
				if (baselineBucketCount <= 0) continue;

				const observedEvents = group.events.filter(
					(event) =>
						event.occurredAt.getTime() >= windowStart.getTime() && event.occurredAt.getTime() < windowEnd.getTime(),
				);
				const baselineEvents = group.events.filter(
					(event) =>
						event.occurredAt.getTime() >= baselineStart.getTime() && event.occurredAt.getTime() < windowStart.getTime(),
				);
				comparisonCount++;
				if (comparisonCount <= anomalyConfig.max_regions * anomalyConfig.max_windows) {
					boundedComparisonCount = comparisonCount;
				}

				const baselineRate = baselineEvents.length / baselineBucketCount;
				const observedRate = observedEvents.length / anomalyConfig.window_size_buckets;
				const expected = Math.max(0.000001, baselineRate * anomalyConfig.window_size_buckets);
				if (observedEvents.length < anomalyConfig.min_entities || observedRate <= baselineRate) {
					cusum = 0;
					consecutiveWindows = 0;
					continue;
				}
				const standardizedShift = (observedEvents.length - expected) / Math.sqrt(expected);
				cusum = Math.max(0, cusum + standardizedShift - changepointConfig.drift_allowance);
				if (cusum >= changepointConfig.threshold) {
					consecutiveWindows++;
				} else {
					consecutiveWindows = 0;
				}
				if (consecutiveWindows < changepointConfig.min_consecutive_windows) continue;

				const rawSignificance = poissonUpperTail(observedEvents.length, expected);
				preliminary.push(
					makeAnomalyCandidate({
						group,
						observedEvents,
						windowStart,
						windowEnd,
						anomalyType: 'frequency_changepoint',
						baselineRate,
						observedRate,
						rawSignificance,
						significanceThreshold: anomalyConfig.significance_threshold,
						granularity: anomalyConfig.granularity,
						knownPatterns: anomalyConfig.known_patterns,
						reportingBias: config.reporting_bias,
						computedAt,
					}),
				);
				cusum = 0;
				consecutiveWindows = 0;
			}
		}
	}

	const corrected = preliminary
		.map((candidate) => {
			const correctedSignificance = Math.min(1, candidate.rawSignificance * Math.max(1, comparisonCount));
			return {
				...candidate,
				input: {
					...candidate.input,
					comparisonCount: Math.max(1, comparisonCount),
					correctedSignificance,
				},
				summary: {
					...candidate.summary,
					correctedSignificance,
				},
			};
		})
		.filter((candidate) => candidate.input.correctedSignificance <= anomalyConfig.significance_threshold)
		.sort(
			(left, right) =>
				left.input.correctedSignificance - right.input.correctedSignificance ||
				left.input.timeStart.getTime() - right.input.timeStart.getTime() ||
				left.input.regionKey.localeCompare(right.input.regionKey),
		);

	return { candidates: corrected, comparisonCount, boundedComparisonCount };
}

function haversineKm(left: NormalizedEvent, right: NormalizedEvent): number {
	if (left.latitude === null || left.longitude === null || right.latitude === null || right.longitude === null) {
		return Number.POSITIVE_INFINITY;
	}
	const leftLat = (left.latitude * Math.PI) / 180;
	const rightLat = (right.latitude * Math.PI) / 180;
	const deltaLat = ((right.latitude - left.latitude) * Math.PI) / 180;
	const deltaLng = ((right.longitude - left.longitude) * Math.PI) / 180;
	const a =
		Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
		Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
	return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function collectDbscanClusters(
	events: NormalizedEvent[],
	radiusKm: number,
	minClusterSize: number,
): NormalizedEvent[][] {
	const neighborsByIndex = events.map((event, index) => {
		const neighbors: number[] = [];
		for (let candidateIndex = 0; candidateIndex < events.length; candidateIndex++) {
			if (index === candidateIndex || haversineKm(event, events[candidateIndex]) <= radiusKm) {
				neighbors.push(candidateIndex);
			}
		}
		return neighbors;
	});
	const visited = new Set<number>();
	const assigned = new Set<number>();
	const clusters: NormalizedEvent[][] = [];

	for (let index = 0; index < events.length; index++) {
		if (assigned.has(index)) continue;
		visited.add(index);
		const seedNeighbors = neighborsByIndex[index];
		if (seedNeighbors.length < minClusterSize) continue;

		const cluster = new Set<number>();
		const queue = [...seedNeighbors];
		for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
			const neighborIndex = queue[queueIndex];
			if (!assigned.has(neighborIndex)) cluster.add(neighborIndex);
			if (visited.has(neighborIndex)) continue;

			visited.add(neighborIndex);
			const expandedNeighbors = neighborsByIndex[neighborIndex];
			if (expandedNeighbors.length < minClusterSize) continue;
			for (const expandedIndex of expandedNeighbors) {
				if (!assigned.has(expandedIndex)) cluster.add(expandedIndex);
				if (!visited.has(expandedIndex) && !queue.includes(expandedIndex)) queue.push(expandedIndex);
			}
		}

		if (cluster.size < minClusterSize) continue;
		for (const clusterIndex of cluster) assigned.add(clusterIndex);
		clusters.push(
			[...cluster]
				.map((clusterIndex) => events[clusterIndex])
				.sort((left, right) => left.entityId.localeCompare(right.entityId)),
		);
	}

	return clusters.sort(
		(left, right) =>
			right.length - left.length ||
			(left[0]?.occurredAt.getTime() ?? 0) - (right[0]?.occurredAt.getTime() ?? 0) ||
			(left[0]?.entityId ?? '').localeCompare(right[0]?.entityId ?? ''),
	);
}

function deterministicUuid(key: string): string {
	const hash = createHash('sha256').update(key).digest('hex');
	const variant = ((Number.parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

function dateFromOptionalConfig(value: string | undefined): Date | undefined {
	return value ? (parseIsoDate(value) ?? undefined) : undefined;
}

function eventMatchesCategory(event: NormalizedEvent, ref: ClassificationCategoryRef | undefined): boolean {
	if (!ref) return true;
	return event.categoryRefs.some(
		(candidate) =>
			candidate.categoryId === ref.categoryId && (!ref.taxonomyId || candidate.taxonomyId === ref.taxonomyId),
	);
}

function configCategoryRef(
	ref: MulderConfig['temporal_pattern_detection']['external_correlation']['series'][number]['category_ref'],
): ClassificationCategoryRef | undefined {
	return ref ? { categoryId: ref.category_id, taxonomyId: ref.taxonomy_id } : undefined;
}

function buildInternalCorrelationSeries(
	events: readonly NormalizedEvent[],
	series: MulderConfig['temporal_pattern_detection']['external_correlation']['series'][number],
	config: MulderConfig['temporal_pattern_detection'],
): InternalCorrelationSeries {
	const timeStart = dateFromOptionalConfig(series.time_start);
	const timeEnd = dateFromOptionalConfig(series.time_end);
	const categoryRef = configCategoryRef(series.category_ref);
	const filtered = events.filter((event) => {
		if (timeStart && event.occurredAt.getTime() < timeStart.getTime()) return false;
		if (timeEnd && event.occurredAt.getTime() > timeEnd.getTime()) return false;
		if (series.region_key && readRegionKey(event, config.anomaly_detection.region_grid) !== series.region_key)
			return false;
		if (!eventMatchesCategory(event, categoryRef)) return false;
		return true;
	});
	const points = new Map<string, InternalCorrelationBucket>();
	for (const event of filtered) {
		const dateKey = isoDay(startOfUtcDay(event.occurredAt));
		const existing = points.get(dateKey) ?? { value: 0, events: [] };
		existing.value += 1;
		existing.events.push(event);
		points.set(dateKey, existing);
	}
	const categoryKey = categoryRef ? `${categoryRef.taxonomyId ?? ''}:${categoryRef.categoryId}` : 'all';
	const regionKey = series.region_key ?? 'all';
	return {
		key: `entities:region=${regionKey}:category=${categoryKey}`,
		points,
		events: filtered,
	};
}

function normalizeExternalPoints(
	points: readonly ExternalDataPoint[],
	label: string,
): { points: Map<string, number>; warnings: string[] } {
	const normalized = new Map<string, number>();
	const warnings: string[] = [];
	let dropped = 0;
	for (const point of points) {
		const date = point.date instanceof Date ? point.date : parseIsoDate(String(point.date));
		if (!date || !Number.isFinite(point.value)) {
			dropped++;
			continue;
		}
		const key = isoDay(startOfUtcDay(date));
		normalized.set(key, point.value);
	}
	if (dropped > 0) {
		warnings.push(`${label}: dropped ${dropped} invalid external data point(s).`);
	}
	return { points: normalized, warnings };
}

function shiftedDateKey(dateKey: string, lagDays: number): string {
	const date = parseIsoDate(dateKey) ?? new Date(`${dateKey}T00:00:00.000Z`);
	return isoDay(new Date(date.getTime() + lagDays * DAY_MS));
}

function alignSeries(
	internal: InternalCorrelationSeries,
	external: ReadonlyMap<string, number>,
	lagDays: number,
): AlignedCorrelationPoint[] {
	const aligned: AlignedCorrelationPoint[] = [];
	for (const [dateKey, bucket] of [...internal.points.entries()].sort((left, right) =>
		left[0].localeCompare(right[0]),
	)) {
		const externalValue = external.get(shiftedDateKey(dateKey, lagDays));
		if (externalValue === undefined) continue;
		aligned.push({ internalValue: bucket.value, externalValue, dateKey, events: bucket.events });
	}
	return aligned;
}

function averageRanks(values: readonly number[]): number[] {
	const indexed = values
		.map((value, index) => ({ value, index }))
		.sort((left, right) => left.value - right.value || left.index - right.index);
	const ranks = Array(values.length).fill(0) as number[];
	let cursor = 0;
	while (cursor < indexed.length) {
		let end = cursor + 1;
		while (end < indexed.length && indexed[end].value === indexed[cursor].value) end++;
		const rank = (cursor + 1 + end) / 2;
		for (let i = cursor; i < end; i++) ranks[indexed[i].index] = rank;
		cursor = end;
	}
	return ranks;
}

function pearson(left: readonly number[], right: readonly number[]): number {
	if (left.length !== right.length || left.length < 2) return 0;
	const leftMean = left.reduce((total, value) => total + value, 0) / left.length;
	const rightMean = right.reduce((total, value) => total + value, 0) / right.length;
	let numerator = 0;
	let leftDenominator = 0;
	let rightDenominator = 0;
	for (let i = 0; i < left.length; i++) {
		const leftDelta = left[i] - leftMean;
		const rightDelta = right[i] - rightMean;
		numerator += leftDelta * rightDelta;
		leftDenominator += leftDelta * leftDelta;
		rightDenominator += rightDelta * rightDelta;
	}
	const denominator = Math.sqrt(leftDenominator * rightDenominator);
	return denominator === 0 ? 0 : Math.max(-1, Math.min(1, numerator / denominator));
}

function spearman(left: readonly number[], right: readonly number[]): number {
	return pearson(averageRanks(left), averageRanks(right));
}

function pValueApprox(coefficient: number, dataPointCount: number): number {
	if (dataPointCount < 3) return 1;
	const bounded = Math.max(-0.999999, Math.min(0.999999, coefficient));
	const tScore = Math.abs(bounded) * Math.sqrt((dataPointCount - 2) / Math.max(0.000001, 1 - bounded * bounded));
	return Math.max(0, Math.min(1, 2 * normalUpperTail(tScore)));
}

function computeCorrelation(
	method: ExternalCorrelationMethod,
	internal: InternalCorrelationSeries,
	external: ReadonlyMap<string, number>,
	minDataPoints: number,
	maxLagDays: number,
): CorrelationComputation | null {
	const lags = method === 'cross_correlation' ? [...Array(maxLagDays + 1).keys()] : [0];
	let best: CorrelationComputation | null = null;
	for (const lagDays of lags) {
		const aligned = alignSeries(internal, external, lagDays);
		if (aligned.length < minDataPoints) continue;
		const left = aligned.map((point) => point.internalValue);
		const right = aligned.map((point) => point.externalValue);
		const coefficient = method === 'spearman' ? spearman(left, right) : pearson(left, right);
		const pValue = pValueApprox(coefficient, aligned.length);
		const eventById = new Map<string, NormalizedEvent>();
		for (const point of aligned) {
			for (const event of point.events) eventById.set(event.entityId, event);
		}
		const dates = aligned.map((point) => parseIsoDate(point.dateKey) ?? new Date(`${point.dateKey}T00:00:00.000Z`));
		const candidate: CorrelationComputation = {
			method,
			coefficient,
			pValue,
			lagDays,
			timeStart: new Date(Math.min(...dates.map((date) => date.getTime()))),
			timeEnd: new Date(Math.max(...dates.map((date) => date.getTime())) + DAY_MS),
			dataPointCount: aligned.length,
			events: [...eventById.values()].sort((leftEvent, rightEvent) =>
				leftEvent.entityId.localeCompare(rightEvent.entityId),
			),
		};
		if (!best || Math.abs(candidate.coefficient) > Math.abs(best.coefficient) || candidate.lagDays < best.lagDays) {
			best = candidate;
		}
	}
	return best;
}

async function buildExternalCorrelationInputs(
	events: readonly NormalizedEvent[],
	config: MulderConfig['temporal_pattern_detection'],
	computedAt: Date,
	registry: ExternalDataSourceRegistry,
): Promise<ExternalCorrelationBuildResult> {
	const externalConfig = config.external_correlation;
	const inputs: CreateExternalCorrelationInput[] = [];
	const summaries: ExternalCorrelationSummary[] = [];
	const warnings: string[] = [];
	let evaluatedSeriesCount = 0;
	if (!config.enabled || !externalConfig.enabled || externalConfig.series.length === 0) {
		return { inputs, summaries, warnings, evaluatedSeriesCount };
	}

	for (const series of externalConfig.series) {
		const label = `${series.plugin_id}/${series.source_id}/${series.series_id}`;
		if (!series.enabled) {
			warnings.push(`${label}: skipped disabled external series.`);
			continue;
		}
		const plugin = registry.get(series.plugin_id);
		if (!plugin) {
			warnings.push(`${label}: skipped missing external data source plugin.`);
			continue;
		}
		const internal = buildInternalCorrelationSeries(events, series, config);
		if (internal.points.size < externalConfig.min_data_points) {
			warnings.push(`${label}: skipped internal series with fewer than ${externalConfig.min_data_points} data points.`);
			continue;
		}

		let fetched: ExternalDataFetchResult;
		try {
			fetched = await plugin.fetch({
				sourceId: series.source_id,
				seriesId: series.series_id,
				series,
				timeStart: dateFromOptionalConfig(series.time_start),
				timeEnd: dateFromOptionalConfig(series.time_end),
			});
		} catch {
			warnings.push(`${label}: skipped after plugin fetch failed.`);
			continue;
		}
		warnings.push(...(fetched.warnings ?? []).map((warning) => `${label}: ${warning}`));
		const external = normalizeExternalPoints(fetched.points, label);
		warnings.push(...external.warnings);
		if (external.points.size < externalConfig.min_data_points) {
			warnings.push(`${label}: skipped external series with fewer than ${externalConfig.min_data_points} data points.`);
			continue;
		}
		evaluatedSeriesCount += 1;

		for (const method of externalConfig.methods) {
			const computed = computeCorrelation(
				method,
				internal,
				external.points,
				externalConfig.min_data_points,
				externalConfig.max_lag_days,
			);
			if (!computed) {
				warnings.push(`${label}: skipped ${method} because aligned data points were below threshold.`);
				continue;
			}
			const sensitivity = mergeSensitivity(computed.events);
			const contributingEntityIds = computed.events
				.map((event) => event.entityId)
				.sort((left, right) => left.localeCompare(right));
			const id = deterministicUuid(
				`external-correlation:${internal.key}:${series.source_id}:${series.series_id}:${method}:${computed.timeStart.toISOString()}:${computed.timeEnd.toISOString()}:${computed.lagDays}`,
			);
			inputs.push({
				id,
				internalSeriesKey: internal.key,
				externalSourceId: series.source_id,
				externalSeriesId: series.series_id,
				method,
				coefficient: computed.coefficient,
				pValue: computed.pValue,
				lagDays: computed.lagDays,
				timeStart: computed.timeStart,
				timeEnd: computed.timeEnd,
				dataPointCount: computed.dataPointCount,
				contributingEntityIds,
				interpretationCaveat: CORRELATION_CAVEAT,
				caveats: [CORRELATION_CAVEAT],
				provenance: mergeProvenance(computed.events),
				sensitivityLevel: sensitivity.sensitivityLevel,
				sensitivityMetadata: sensitivity.sensitivityMetadata,
				computedAt,
			});
			summaries.push({
				internalSeriesKey: internal.key,
				externalSourceId: series.source_id,
				externalSeriesId: series.series_id,
				method,
				coefficient: computed.coefficient,
				pValue: computed.pValue,
				lagDays: computed.lagDays,
				timeStart: computed.timeStart,
				timeEnd: computed.timeEnd,
				dataPointCount: computed.dataPointCount,
				contributingEntityIds,
				interpretationCaveat: CORRELATION_CAVEAT,
			});
		}
	}
	return { inputs, summaries, warnings, evaluatedSeriesCount };
}

function hotspotGroupKey(latitude: number, longitude: number): string {
	return `hotspot:${Math.round(latitude)}:${Math.round(longitude)}`;
}

function monthsForGranularity(
	granularity: MulderConfig['temporal_pattern_detection']['hotspot_clustering']['temporal_granularity'],
): number {
	switch (granularity) {
		case 'day':
			return 1 / 30;
		case 'week':
			return 7 / 30;
		case 'month':
			return 1;
		case 'year':
			return 12;
	}
}

function yearsBetween(start: Date, end: Date): number {
	return Math.max(0, (end.getTime() - start.getTime()) / (365.25 * DAY_MS));
}

function persistenceForGroup(
	group: readonly HotspotCandidate[],
	latestBucketKey: number | null,
	thresholdYears: number,
): HotspotPersistence {
	if (group.length <= 1) return 'transient';
	const sorted = [...group].sort((left, right) => left.bucketKey - right.bucketKey);
	const spanYears = yearsBetween(sorted[0].timeStart, sorted[sorted.length - 1].timeEnd);
	if (spanYears >= thresholdYears && sorted[sorted.length - 1].bucketKey === latestBucketKey) return 'permanent';
	return 'recurring';
}

function recurrencePatternForGroup(
	group: readonly HotspotCandidate[],
	granularity: MulderConfig['temporal_pattern_detection']['hotspot_clustering']['temporal_granularity'],
): string | null {
	if (group.length <= 1) return null;
	const sorted = [...group].sort((left, right) => left.bucketKey - right.bucketKey);
	return `observed_in_${group.length}_${granularity}_windows_from_${isoDay(sorted[0].timeStart)}_to_${isoDay(sorted[sorted.length - 1].timeEnd)}`;
}

function buildHotspotCandidates(
	events: NormalizedEvent[],
	config: MulderConfig['temporal_pattern_detection'],
	computedAt: Date,
): HotspotInputWithSummary[] {
	const hotspotConfig = config.hotspot_clustering;
	if (!config.enabled || !hotspotConfig.enabled) return [];

	const geocoded = events
		.filter((event) => event.latitude !== null && event.longitude !== null)
		.sort(
			(left, right) =>
				left.occurredAt.getTime() - right.occurredAt.getTime() || left.entityId.localeCompare(right.entityId),
		);
	const buckets = new Map<number, NormalizedEvent[]>();
	for (const event of geocoded) {
		const key = bucketStart(event.occurredAt, hotspotConfig.temporal_granularity).getTime();
		buckets.set(key, [...(buckets.get(key) ?? []), event]);
	}

	const candidates: HotspotCandidate[] = [];
	for (const [bucketKey, bucketEvents] of [...buckets.entries()].sort((left, right) => left[0] - right[0])) {
		for (const component of collectDbscanClusters(
			bucketEvents,
			hotspotConfig.radius_km,
			hotspotConfig.min_cluster_size,
		)) {
			const centroidLat = component.reduce((total, event) => total + (event.latitude ?? 0), 0) / component.length;
			const centroidLng = component.reduce((total, event) => total + (event.longitude ?? 0), 0) / component.length;
			const timeStart = new Date(bucketKey);
			const timeEnd = addBuckets(timeStart, 1, hotspotConfig.temporal_granularity);
			const groupKey = hotspotGroupKey(centroidLat, centroidLng);
			const entityIds = component.map((event) => event.entityId).join(',');
			candidates.push({
				id: deterministicUuid(`${groupKey}:${bucketKey}:${entityIds}`),
				groupKey,
				bucketKey,
				centroidLat,
				centroidLng,
				timeStart,
				timeEnd,
				events: component,
			});
		}
	}

	const latestBucketKey =
		candidates.length === 0 ? null : Math.max(...candidates.map((candidate) => candidate.bucketKey));
	const byGroup = new Map<string, HotspotCandidate[]>();
	for (const candidate of candidates) {
		byGroup.set(candidate.groupKey, [...(byGroup.get(candidate.groupKey) ?? []), candidate]);
	}

	return candidates
		.map((candidate) => {
			const group = byGroup.get(candidate.groupKey) ?? [candidate];
			const relatedClusterIds = group
				.map((related) => related.id)
				.filter((id) => id !== candidate.id)
				.sort((left, right) => left.localeCompare(right));
			const sensitivity = mergeSensitivity(candidate.events);
			const areaKm2 = Math.PI * hotspotConfig.radius_km * hotspotConfig.radius_km;
			const months = monthsForGranularity(hotspotConfig.temporal_granularity);
			const density = candidate.events.length / Math.max(1, areaKm2 * months);
			const contributingEntityIds = candidate.events
				.map((event) => event.entityId)
				.sort((left, right) => left.localeCompare(right));
			const input: CreateSpatiotemporalHotspotClusterInput = {
				id: candidate.id,
				regionKey: candidate.groupKey,
				hotspotType: 'density_cluster',
				centroidLat: candidate.centroidLat,
				centroidLng: candidate.centroidLng,
				radiusKm: hotspotConfig.radius_km,
				timeStart: candidate.timeStart,
				timeEnd: candidate.timeEnd,
				entityCount: candidate.events.length,
				density,
				persistence: persistenceForGroup(group, latestBucketKey, hotspotConfig.persistence_threshold_years),
				recurrencePattern: recurrencePatternForGroup(group, hotspotConfig.temporal_granularity),
				relatedClusterIds,
				contributingEntityIds,
				dominantCategoryRef: dominantCategoryRef(candidate.events),
				biasWarning: reportingBiasWarning(candidate.events, config.reporting_bias),
				caveats: [WEAK_SIGNAL_CAVEAT],
				provenance: mergeProvenance(candidate.events),
				sensitivityLevel: sensitivity.sensitivityLevel,
				sensitivityMetadata: sensitivity.sensitivityMetadata,
				computedAt,
			};
			return {
				input,
				summary: {
					regionKey: input.regionKey,
					centroidLat: input.centroidLat,
					centroidLng: input.centroidLng,
					timeStart: input.timeStart,
					timeEnd: input.timeEnd,
					entityCount: input.entityCount,
					density: input.density,
					persistence: input.persistence,
					contributingEntityIds,
				},
			};
		})
		.sort(
			(left, right) =>
				right.input.density - left.input.density ||
				left.input.timeStart.getTime() - right.input.timeStart.getTime() ||
				left.input.regionKey.localeCompare(right.input.regionKey),
		)
		.slice(0, hotspotConfig.max_clusters);
}

function makeSkippedResult(reason: string): TemporalPatternDetectionResult {
	return {
		status: 'skipped',
		data: {
			mode: 'temporal-patterns',
			eventCount: 0,
			timestampEventCount: 0,
			geometryEventCount: 0,
			anomalyComparisonCount: 0,
			anomalyCount: 0,
			hotspotCount: 0,
			externalCorrelationCount: 0,
			persistedAnomalyCount: 0,
			persistedHotspotCount: 0,
			persistedExternalCorrelationCount: 0,
			warnings: [reason],
			caveat: WEAK_SIGNAL_CAVEAT,
			anomalies: [],
			hotspots: [],
			externalCorrelations: [],
		},
		snapshot: { anomalies: [], hotspots: [], externalCorrelations: [] },
	};
}

export async function detectTemporalPatterns(
	pool: pg.Pool,
	config: MulderConfig,
	options?: { externalDataSourceRegistry?: ExternalDataSourceRegistry },
): Promise<TemporalPatternDetectionResult> {
	if (!config.temporal_pattern_detection.enabled) {
		return makeSkippedResult('temporal pattern detection is disabled in the active configuration');
	}

	const rawEvents = await loadTemporalPatternEntityEvents(pool);
	const events = rawEvents
		.map(normalizeEvent)
		.filter((event): event is NormalizedEvent => event !== null)
		.sort(
			(left, right) =>
				left.occurredAt.getTime() - right.occurredAt.getTime() || left.entityId.localeCompare(right.entityId),
		);
	const geometryEventCount = events.filter((event) => event.latitude !== null && event.longitude !== null).length;
	const computedAt = new Date();

	const anomalies = buildAnomalyCandidates(events, config.temporal_pattern_detection, computedAt);
	const hotspots = buildHotspotCandidates(events, config.temporal_pattern_detection, computedAt);
	const externalCorrelations = await buildExternalCorrelationInputs(
		events,
		config.temporal_pattern_detection,
		computedAt,
		options?.externalDataSourceRegistry ?? getExternalDataSourceRegistry(),
	);
	const snapshot = await replaceTemporalPatternSnapshot(pool, {
		anomalies: anomalies.candidates.map((candidate) => candidate.input),
		hotspots: hotspots.map((candidate) => candidate.input),
	});
	const externalCorrelationSnapshot =
		externalCorrelations.inputs.length > 0
			? await replaceExternalCorrelationSnapshot(pool, {
					correlations: externalCorrelations.inputs,
				})
			: { correlations: [] };
	const warnings: string[] = [];
	if (anomalies.comparisonCount > anomalies.boundedComparisonCount && anomalies.boundedComparisonCount > 0) {
		warnings.push('Temporal anomaly comparisons were bounded by configured max region/window limits.');
	}
	if (events.length === 0) {
		warnings.push('No timestamp-bearing entity events were available for temporal pattern detection.');
	}
	warnings.push(...externalCorrelations.warnings);

	const data: TemporalPatternAnalyzeData = {
		mode: 'temporal-patterns',
		eventCount: rawEvents.length,
		timestampEventCount: events.length,
		geometryEventCount,
		anomalyComparisonCount: anomalies.comparisonCount,
		anomalyCount: anomalies.candidates.length,
		hotspotCount: hotspots.length,
		externalCorrelationCount: externalCorrelations.summaries.length,
		persistedAnomalyCount: snapshot.anomalies.length,
		persistedHotspotCount: snapshot.hotspots.length,
		persistedExternalCorrelationCount: externalCorrelationSnapshot.correlations.length,
		warnings,
		caveat: WEAK_SIGNAL_CAVEAT,
		anomalies: anomalies.candidates.map((candidate) => candidate.summary),
		hotspots: hotspots.map((candidate) => candidate.summary),
		externalCorrelations: externalCorrelations.summaries,
	};

	return {
		status: 'success',
		data,
		snapshot: { ...snapshot, externalCorrelations: externalCorrelationSnapshot.correlations },
	};
}
