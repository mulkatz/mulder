import { ANALYZE_ERROR_CODES, AnalyzeError, type TemporalExternalCorrelationSeriesConfig } from '@mulder/core';

export type ExternalDataSourceType = 'time_series' | 'event_list' | 'static_dataset';
export type ExternalDataSourceKind = ExternalDataSourceType;
export type ExternalDataUpdateFrequency = 'realtime' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'manual';

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

export interface ExternalDataSource {
	id: string;
	name: string;
	description: string;
	type: ExternalDataSourceType;
	update_frequency: ExternalDataUpdateFrequency;
	fetch(request: ExternalDataFetchRequest): Promise<ExternalDataFetchResult> | ExternalDataFetchResult;
}

export type ExternalDataSourcePlugin = ExternalDataSource;

const EXTERNAL_DATA_SOURCE_TYPES: readonly ExternalDataSourceType[] = ['time_series', 'event_list', 'static_dataset'];
const EXTERNAL_DATA_UPDATE_FREQUENCIES: readonly ExternalDataUpdateFrequency[] = [
	'realtime',
	'daily',
	'weekly',
	'monthly',
	'yearly',
	'manual',
];

function pluginValidationError(message: string, context: Record<string, unknown>): AnalyzeError {
	return new AnalyzeError(message, ANALYZE_ERROR_CODES.ANALYZE_VALIDATION_FAILED, { context });
}

function requiredPluginText(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw pluginValidationError(`External data source plugin ${field} must be a non-empty string.`, {
			field,
		});
	}
	return value.trim();
}

function requiredPluginType(value: unknown): ExternalDataSourceType {
	switch (value) {
		case 'time_series':
		case 'event_list':
		case 'static_dataset':
			return value;
		default:
			throw pluginValidationError('External data source plugin type is invalid.', {
				field: 'type',
				value,
				allowed: [...EXTERNAL_DATA_SOURCE_TYPES],
			});
	}
}

function requiredPluginUpdateFrequency(value: unknown): ExternalDataUpdateFrequency {
	switch (value) {
		case 'realtime':
		case 'daily':
		case 'weekly':
		case 'monthly':
		case 'yearly':
		case 'manual':
			return value;
		default:
			throw pluginValidationError('External data source plugin update_frequency is invalid.', {
				field: 'update_frequency',
				value,
				allowed: [...EXTERNAL_DATA_UPDATE_FREQUENCIES],
			});
	}
}

export class ExternalDataSourceRegistry {
	private readonly plugins = new Map<string, ExternalDataSource>();

	register(plugin: ExternalDataSource): void {
		const id = requiredPluginText(plugin.id, 'id');
		const name = requiredPluginText(plugin.name, 'name');
		const description = requiredPluginText(plugin.description, 'description');
		const type = requiredPluginType(plugin.type);
		const updateFrequency = requiredPluginUpdateFrequency(plugin.update_frequency);
		if (typeof plugin.fetch !== 'function') {
			throw pluginValidationError('External data source plugin fetch must be a function.', { field: 'fetch', id });
		}
		this.plugins.set(id, { ...plugin, id, name, description, type, update_frequency: updateFrequency });
	}

	get(pluginId: string): ExternalDataSource | null {
		return this.plugins.get(pluginId.trim()) ?? null;
	}

	list(): ExternalDataSource[] {
		return [...this.plugins.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	clear(): void {
		this.plugins.clear();
	}
}

const defaultExternalDataSourceRegistry = new ExternalDataSourceRegistry();

export function registerExternalDataSourcePlugin(plugin: ExternalDataSource): void {
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
	name?: string;
	description?: string;
	type?: ExternalDataSourceType;
	update_frequency?: ExternalDataUpdateFrequency;
	series: Record<string, readonly ExternalDataPoint[]>;
}): ExternalDataSource {
	const seriesById = new Map(
		Object.entries(input.series).map(([seriesId, points]) => [seriesId, points.map((point) => ({ ...point }))]),
	);
	return {
		id: input.id,
		name: input.name ?? input.id,
		description: input.description ?? 'Static external data source plugin for deterministic local analysis.',
		type: input.type ?? 'time_series',
		update_frequency: input.update_frequency ?? 'manual',
		fetch(request) {
			return {
				points: (seriesById.get(request.seriesId) ?? []).map((point) => ({ ...point })),
			};
		},
	};
}
