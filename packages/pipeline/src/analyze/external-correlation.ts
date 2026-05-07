import type { TemporalExternalCorrelationSeriesConfig } from '@mulder/core';

export type ExternalDataSourceKind = 'time_series' | 'event_list' | 'static_dataset';
export type ExternalDataUpdateFrequency = 'static' | 'manual' | 'daily' | 'weekly' | 'monthly' | 'unknown';

export interface ExternalDataPoint {
	date: Date | string;
	value: number;
	metadata?: Record<string, unknown>;
}

export interface ExternalEvent {
	date: Date | string;
	value?: number;
	metadata?: Record<string, unknown>;
}

export interface ExternalStaticDataset {
	points: ExternalDataPoint[];
	metadata?: Record<string, unknown>;
}

export interface ExternalDataFetchRequest {
	sourceId: string;
	seriesId: string;
	series: TemporalExternalCorrelationSeriesConfig;
	timeStart?: Date;
	timeEnd?: Date;
}

export interface ExternalDataFetchResult {
	points: ExternalDataPoint[];
	warnings?: string[];
}

export interface ExternalDataSourcePlugin {
	id: string;
	kind: ExternalDataSourceKind;
	updateFrequency: ExternalDataUpdateFrequency;
	fetch(request: ExternalDataFetchRequest): Promise<ExternalDataFetchResult> | ExternalDataFetchResult;
}

export class ExternalDataSourceRegistry {
	private readonly plugins = new Map<string, ExternalDataSourcePlugin>();

	register(plugin: ExternalDataSourcePlugin): void {
		const id = plugin.id.trim();
		if (id.length === 0) {
			throw new Error('External data source plugin id must be a non-empty string.');
		}
		this.plugins.set(id, { ...plugin, id });
	}

	get(pluginId: string): ExternalDataSourcePlugin | null {
		return this.plugins.get(pluginId.trim()) ?? null;
	}

	list(): ExternalDataSourcePlugin[] {
		return [...this.plugins.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	clear(): void {
		this.plugins.clear();
	}
}

const defaultExternalDataSourceRegistry = new ExternalDataSourceRegistry();

export function registerExternalDataSourcePlugin(plugin: ExternalDataSourcePlugin): void {
	defaultExternalDataSourceRegistry.register(plugin);
}

export function clearExternalDataSourcePlugins(): void {
	defaultExternalDataSourceRegistry.clear();
}

export function getExternalDataSourceRegistry(): ExternalDataSourceRegistry {
	return defaultExternalDataSourceRegistry;
}

export function createStaticExternalDataSourcePlugin(input: {
	id: string;
	kind?: ExternalDataSourceKind;
	updateFrequency?: ExternalDataUpdateFrequency;
	series: Record<string, readonly ExternalDataPoint[]>;
}): ExternalDataSourcePlugin {
	const seriesById = new Map(
		Object.entries(input.series).map(([seriesId, points]) => [seriesId, points.map((point) => ({ ...point }))]),
	);
	return {
		id: input.id,
		kind: input.kind ?? 'time_series',
		updateFrequency: input.updateFrequency ?? 'static',
		fetch(request) {
			return {
				points: (seriesById.get(request.seriesId) ?? []).map((point) => ({ ...point })),
			};
		},
	};
}
