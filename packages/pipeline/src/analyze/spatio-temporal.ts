/**
 * Spatio-temporal cluster computation for the Analyze step.
 *
 * Loads clusterable events from entity rows, uses PostGIS-backed proximity
 * pairs for spatial grouping, and derives temporal / spatial / combined
 * connected components deterministically.
 *
 * @see docs/specs/64_spatio_temporal_clustering.spec.md §4.1
 * @see docs/functional-spec.md §2.8
 */

import type { ClusterableEntityEvent, CreateSpatioTemporalClusterInput, SpatialEntityEventPair } from '@mulder/core';
import { findSpatialEntityEventPairs, loadClusterableEntityEvents } from '@mulder/core';
import type pg from 'pg';
import type { SpatioTemporalCluster, SpatioTemporalClusterType, SpatioTemporalEvent } from './types.js';

const DEFAULT_SPATIAL_CLUSTER_RADIUS_METERS = 100;
const COORDINATE_PRECISION = 6;
const CLUSTER_TYPE_ORDER: Readonly<Record<SpatioTemporalClusterType, number>> = {
	temporal: 0,
	spatial: 1,
	'spatio-temporal': 2,
};

export interface SpatioTemporalComputation {
	eventCount: number;
	timestampEventCount: number;
	geometryEventCount: number;
	spatioTemporalEventCount: number;
	threshold: number;
	belowThreshold: boolean;
	nothingToAnalyze: boolean;
	temporalClusterCount: number;
	spatialClusterCount: number;
	spatioTemporalClusterCount: number;
	clusters: SpatioTemporalCluster[];
	snapshotRows: CreateSpatioTemporalClusterInput[];
	warning: string | null;
}

function roundCoordinate(value: number): number {
	return Number(value.toFixed(COORDINATE_PRECISION));
}

function parseIsoDate(value: string | null): Date | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const normalizedValue = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
	const timestamp = Date.parse(normalizedValue);
	if (Number.isNaN(timestamp)) {
		return null;
	}

	return new Date(timestamp);
}

function normalizeEvent(rawEvent: ClusterableEntityEvent): SpatioTemporalEvent | null {
	const occurredAt = parseIsoDate(rawEvent.isoDate);
	const latitude = typeof rawEvent.latitude === 'number' ? rawEvent.latitude : null;
	const longitude = typeof rawEvent.longitude === 'number' ? rawEvent.longitude : null;

	if (occurredAt === null && latitude === null && longitude === null) {
		return null;
	}

	return {
		entityId: rawEvent.eventId,
		isoDate: rawEvent.isoDate,
		occurredAt,
		latitude,
		longitude,
	};
}

function hasTimestamp(event: SpatioTemporalEvent): boolean {
	return event.occurredAt !== null;
}

function hasGeometry(event: SpatioTemporalEvent): boolean {
	return event.latitude !== null && event.longitude !== null;
}

function ensureAdjacency(ids: string[]): Map<string, Set<string>> {
	return new Map(ids.map((id) => [id, new Set<string>()]));
}

function addUndirectedEdge(adjacency: Map<string, Set<string>>, leftId: string, rightId: string): void {
	adjacency.get(leftId)?.add(rightId);
	adjacency.get(rightId)?.add(leftId);
}

function collectConnectedComponents(adjacency: Map<string, Set<string>>): string[][] {
	const visited = new Set<string>();
	const components: string[][] = [];

	for (const eventId of adjacency.keys()) {
		if (visited.has(eventId)) {
			continue;
		}

		const stack = [eventId];
		const component: string[] = [];

		while (stack.length > 0) {
			const currentId = stack.pop();
			if (!currentId || visited.has(currentId)) {
				continue;
			}

			visited.add(currentId);
			component.push(currentId);

			for (const neighborId of adjacency.get(currentId) ?? []) {
				if (!visited.has(neighborId)) {
					stack.push(neighborId);
				}
			}
		}

		if (component.length > 1) {
			component.sort((left, right) => left.localeCompare(right));
			components.push(component);
		}
	}

	return components;
}

function buildTemporalAdjacency(events: SpatioTemporalEvent[], windowMs: number): Map<string, Set<string>> {
	const sortedEvents = [...events].sort((left, right) => {
		const leftTime = left.occurredAt?.getTime() ?? 0;
		const rightTime = right.occurredAt?.getTime() ?? 0;
		if (leftTime !== rightTime) {
			return leftTime - rightTime;
		}
		return left.entityId.localeCompare(right.entityId);
	});

	const adjacency = ensureAdjacency(sortedEvents.map((event) => event.entityId));

	for (let leftIndex = 0; leftIndex < sortedEvents.length; leftIndex++) {
		const leftEvent = sortedEvents[leftIndex];
		const leftTime = leftEvent.occurredAt?.getTime();
		if (leftTime === undefined) {
			continue;
		}

		for (let rightIndex = leftIndex + 1; rightIndex < sortedEvents.length; rightIndex++) {
			const rightEvent = sortedEvents[rightIndex];
			const rightTime = rightEvent.occurredAt?.getTime();
			if (rightTime === undefined) {
				continue;
			}

			const difference = rightTime - leftTime;
			if (difference > windowMs) {
				break;
			}

			addUndirectedEdge(adjacency, leftEvent.entityId, rightEvent.entityId);
		}
	}

	return adjacency;
}

function buildSpatialAdjacency(eventIds: string[], pairs: SpatialEntityEventPair[]): Map<string, Set<string>> {
	const adjacency = ensureAdjacency(eventIds);

	for (const pair of pairs) {
		addUndirectedEdge(adjacency, pair.eventIdA, pair.eventIdB);
	}

	return adjacency;
}

function buildCombinedAdjacency(
	eventsById: Map<string, SpatioTemporalEvent>,
	dualQualifiedIds: Set<string>,
	pairs: SpatialEntityEventPair[],
	windowMs: number,
): Map<string, Set<string>> {
	const adjacency = ensureAdjacency([...dualQualifiedIds]);

	for (const pair of pairs) {
		if (!dualQualifiedIds.has(pair.eventIdA) || !dualQualifiedIds.has(pair.eventIdB)) {
			continue;
		}

		const leftEvent = eventsById.get(pair.eventIdA);
		const rightEvent = eventsById.get(pair.eventIdB);
		const leftTime = leftEvent?.occurredAt?.getTime();
		const rightTime = rightEvent?.occurredAt?.getTime();
		if (leftTime === undefined || rightTime === undefined) {
			continue;
		}

		if (Math.abs(leftTime - rightTime) <= windowMs) {
			addUndirectedEdge(adjacency, pair.eventIdA, pair.eventIdB);
		}
	}

	return adjacency;
}

function buildCluster(
	clusterType: SpatioTemporalClusterType,
	componentIds: string[],
	eventsById: Map<string, SpatioTemporalEvent>,
): SpatioTemporalCluster {
	const events = componentIds
		.map((eventId) => eventsById.get(eventId))
		.filter((event): event is SpatioTemporalEvent => event !== undefined);

	const timestampedEvents = events.filter(hasTimestamp);
	const geocodedEvents = events.filter(hasGeometry);

	const timeStart =
		timestampedEvents.length === 0
			? null
			: new Date(
					Math.min(...timestampedEvents.map((event) => event.occurredAt?.getTime() ?? Number.POSITIVE_INFINITY)),
				);
	const timeEnd =
		timestampedEvents.length === 0
			? null
			: new Date(
					Math.max(...timestampedEvents.map((event) => event.occurredAt?.getTime() ?? Number.NEGATIVE_INFINITY)),
				);

	const centerLat =
		geocodedEvents.length === 0
			? null
			: roundCoordinate(
					geocodedEvents.reduce((total, event) => total + (event.latitude ?? 0), 0) / geocodedEvents.length,
				);
	const centerLng =
		geocodedEvents.length === 0
			? null
			: roundCoordinate(
					geocodedEvents.reduce((total, event) => total + (event.longitude ?? 0), 0) / geocodedEvents.length,
				);

	return {
		clusterType,
		centerLat,
		centerLng,
		timeStart,
		timeEnd,
		eventCount: componentIds.length,
		eventIds: [...componentIds].sort((left, right) => left.localeCompare(right)),
	};
}

function sortClusters(clusters: SpatioTemporalCluster[]): SpatioTemporalCluster[] {
	return [...clusters].sort((left, right) => {
		const typeDelta = CLUSTER_TYPE_ORDER[left.clusterType] - CLUSTER_TYPE_ORDER[right.clusterType];
		if (typeDelta !== 0) {
			return typeDelta;
		}

		const leftStart = left.timeStart?.getTime() ?? Number.POSITIVE_INFINITY;
		const rightStart = right.timeStart?.getTime() ?? Number.POSITIVE_INFINITY;
		if (leftStart !== rightStart) {
			return leftStart - rightStart;
		}

		if (right.eventCount !== left.eventCount) {
			return right.eventCount - left.eventCount;
		}

		return left.eventIds.join(',').localeCompare(right.eventIds.join(','));
	});
}

function dedupeClusters(clusters: SpatioTemporalCluster[]): SpatioTemporalCluster[] {
	const uniqueClusters = new Map<string, SpatioTemporalCluster>();

	for (const cluster of clusters) {
		const key = `${cluster.clusterType}:${cluster.eventIds.join(',')}`;
		if (!uniqueClusters.has(key)) {
			uniqueClusters.set(key, cluster);
		}
	}

	return sortClusters([...uniqueClusters.values()]);
}

function buildClustersFromAdjacency(
	clusterType: SpatioTemporalClusterType,
	eventsById: Map<string, SpatioTemporalEvent>,
	adjacency: Map<string, Set<string>>,
): SpatioTemporalCluster[] {
	return collectConnectedComponents(adjacency).map((componentIds) =>
		buildCluster(clusterType, componentIds, eventsById),
	);
}

function toSnapshotRows(clusters: SpatioTemporalCluster[], computedAt: Date): CreateSpatioTemporalClusterInput[] {
	return clusters.map((cluster) => ({
		centerLat: cluster.centerLat,
		centerLng: cluster.centerLng,
		timeStart: cluster.timeStart,
		timeEnd: cluster.timeEnd,
		eventCount: cluster.eventCount,
		eventIds: cluster.eventIds,
		clusterType: cluster.clusterType,
		computedAt,
	}));
}

export async function computeSpatioTemporalClusters(
	pool: pg.Pool,
	clusterWindowDays: number,
	threshold: number,
): Promise<SpatioTemporalComputation> {
	const rawEvents = await loadClusterableEntityEvents(pool);
	const events = rawEvents
		.map(normalizeEvent)
		.filter((event): event is SpatioTemporalEvent => event !== null)
		.sort((left, right) => left.entityId.localeCompare(right.entityId));

	if (events.length === 0) {
		return {
			eventCount: 0,
			timestampEventCount: 0,
			geometryEventCount: 0,
			spatioTemporalEventCount: 0,
			threshold,
			belowThreshold: false,
			nothingToAnalyze: true,
			temporalClusterCount: 0,
			spatialClusterCount: 0,
			spatioTemporalClusterCount: 0,
			clusters: [],
			snapshotRows: [],
			warning: null,
		};
	}

	const timestampEvents = events.filter(hasTimestamp);
	const geometryEvents = events.filter(hasGeometry);
	const dualEvents = events.filter((event) => hasTimestamp(event) && hasGeometry(event));

	if (timestampEvents.length < threshold) {
		return {
			eventCount: events.length,
			timestampEventCount: timestampEvents.length,
			geometryEventCount: geometryEvents.length,
			spatioTemporalEventCount: dualEvents.length,
			threshold,
			belowThreshold: true,
			nothingToAnalyze: false,
			temporalClusterCount: 0,
			spatialClusterCount: 0,
			spatioTemporalClusterCount: 0,
			clusters: [],
			snapshotRows: [],
			warning: `Corpus below temporal clustering threshold (${timestampEvents.length}/${threshold} timestamp-bearing events)`,
		};
	}

	const eventsById = new Map(events.map((event) => [event.entityId, event]));
	const spatialPairs = await findSpatialEntityEventPairs(
		pool,
		geometryEvents.map((event) => event.entityId),
		DEFAULT_SPATIAL_CLUSTER_RADIUS_METERS,
	);
	const windowMs = clusterWindowDays * 24 * 60 * 60 * 1000;

	const temporalClusters = buildClustersFromAdjacency(
		'temporal',
		eventsById,
		buildTemporalAdjacency(timestampEvents, windowMs),
	);
	const spatialClusters = buildClustersFromAdjacency(
		'spatial',
		eventsById,
		buildSpatialAdjacency(
			geometryEvents.map((event) => event.entityId),
			spatialPairs,
		),
	);
	const spatioTemporalClusters = buildClustersFromAdjacency(
		'spatio-temporal',
		eventsById,
		buildCombinedAdjacency(eventsById, new Set(dualEvents.map((event) => event.entityId)), spatialPairs, windowMs),
	);

	const clusters = dedupeClusters([...temporalClusters, ...spatialClusters, ...spatioTemporalClusters]);
	const computedAt = new Date();

	return {
		eventCount: events.length,
		timestampEventCount: timestampEvents.length,
		geometryEventCount: geometryEvents.length,
		spatioTemporalEventCount: dualEvents.length,
		threshold,
		belowThreshold: false,
		nothingToAnalyze: false,
		temporalClusterCount: temporalClusters.length,
		spatialClusterCount: spatialClusters.length,
		spatioTemporalClusterCount: spatioTemporalClusters.length,
		clusters,
		snapshotRows: toSnapshotRows(clusters, computedAt),
		warning: null,
	};
}
