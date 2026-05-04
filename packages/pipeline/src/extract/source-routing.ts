/**
 * Source-type keyed routing for the extract step.
 *
 * The persisted `sources.source_type` value is the dispatch contract. Route
 * local validation may still inspect media metadata or content bytes after a
 * route is selected.
 *
 * @see docs/specs/95_format_aware_extract_routing.spec.md
 */

import type { SourceType } from '@mulder/core';
import { EXTRACT_ERROR_CODES, ExtractError } from '@mulder/core';

export type ExtractRouteKind = 'layout' | 'prestructured';

export type LayoutExtractSourceType = Extract<SourceType, 'pdf' | 'image'>;
export type PrestructuredExtractSourceType = Extract<SourceType, 'text' | 'docx' | 'spreadsheet' | 'email' | 'url'>;

export interface LayoutExtractRoute {
	sourceType: LayoutExtractSourceType;
	kind: 'layout';
	fallbackOnlySupported: true;
}

export interface PrestructuredExtractRoute {
	sourceType: PrestructuredExtractSourceType;
	kind: 'prestructured';
	fallbackOnlySupported: false;
}

export type ExtractSourceRoute = LayoutExtractRoute | PrestructuredExtractRoute;

export const EXTRACT_LAYOUT_SOURCE_TYPES: readonly SourceType[] = ['pdf', 'image'];

export const EXTRACT_PRESTRUCTURED_SOURCE_TYPES: readonly SourceType[] = [
	'text',
	'docx',
	'spreadsheet',
	'email',
	'url',
];

export const EXTRACT_SOURCE_TYPES: readonly SourceType[] = [
	...EXTRACT_LAYOUT_SOURCE_TYPES,
	...EXTRACT_PRESTRUCTURED_SOURCE_TYPES,
];

export function isAcceptedExtractSourceType(sourceType: string): sourceType is SourceType {
	switch (sourceType) {
		case 'pdf':
		case 'image':
		case 'text':
		case 'docx':
		case 'spreadsheet':
		case 'email':
		case 'url':
			return true;
		default:
			return false;
	}
}

export function resolveExtractRoute(sourceType: SourceType): ExtractSourceRoute {
	switch (sourceType) {
		case 'pdf':
		case 'image':
			return {
				sourceType,
				kind: 'layout',
				fallbackOnlySupported: true,
			};
		case 'text':
		case 'docx':
		case 'spreadsheet':
		case 'email':
		case 'url':
			return {
				sourceType,
				kind: 'prestructured',
				fallbackOnlySupported: false,
			};
	}
}

export function requireExtractRoute(sourceType: string, context: Record<string, unknown> = {}): ExtractSourceRoute {
	if (isAcceptedExtractSourceType(sourceType)) {
		return resolveExtractRoute(sourceType);
	}

	throw new ExtractError(
		`Source type "${sourceType}" is not supported by extract`,
		EXTRACT_ERROR_CODES.EXTRACT_INVALID_STATUS,
		{
			context: {
				...context,
				sourceType,
				acceptedSourceTypes: [...EXTRACT_SOURCE_TYPES],
			},
		},
	);
}

export function assertFallbackOnlySupported(route: ExtractSourceRoute, context: Record<string, unknown> = {}): void {
	if (route.fallbackOnlySupported) {
		return;
	}

	throw new ExtractError(
		`Source type "${route.sourceType}" does not support vision fallback`,
		EXTRACT_ERROR_CODES.EXTRACT_INVALID_STATUS,
		{
			context: {
				...context,
				sourceType: route.sourceType,
				routeKind: route.kind,
				fallbackOnly: true,
				fallbackOnlySupportedSourceTypes: [...EXTRACT_LAYOUT_SOURCE_TYPES],
			},
		},
	);
}
