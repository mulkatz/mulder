export const SENSITIVITY_LEVELS = ['public', 'internal', 'restricted', 'confidential'] as const;

export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

export const SENSITIVITY_ASSIGNMENT_SOURCES = ['llm_auto', 'human', 'policy_rule'] as const;

export type SensitivityAssignmentSource = (typeof SENSITIVITY_ASSIGNMENT_SOURCES)[number];

export const PII_TYPES = [
	'person_name',
	'contact_info',
	'medical_data',
	'location_private',
	'location_sighting',
	'financial',
	'unpublished_research',
	'legal',
] as const;

export type PIIType = (typeof PII_TYPES)[number];

export interface SensitivityMetadata {
	level: SensitivityLevel;
	reason: string;
	assignedBy: SensitivityAssignmentSource;
	assignedAt: string;
	piiTypes: PIIType[];
	declassifyDate: string | null;
}

export interface SensitivityTagged {
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
}

export type SensitivityMetadataInput =
	| Partial<SensitivityMetadata>
	| {
			level?: unknown;
			reason?: unknown;
			assigned_by?: unknown;
			assignedBy?: unknown;
			assigned_at?: unknown;
			assignedAt?: unknown;
			pii_types?: unknown;
			piiTypes?: unknown;
			declassify_date?: unknown;
			declassifyDate?: unknown;
	  };

const SENSITIVITY_RANK = new Map<SensitivityLevel, number>(SENSITIVITY_LEVELS.map((level, index) => [level, index]));

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSensitivityLevel(value: unknown): value is SensitivityLevel {
	return typeof value === 'string' && SENSITIVITY_LEVELS.some((level) => level === value);
}

function isSensitivityAssignmentSource(value: unknown): value is SensitivityAssignmentSource {
	return typeof value === 'string' && SENSITIVITY_ASSIGNMENT_SOURCES.some((source) => source === value);
}

function isPIIType(value: unknown): value is PIIType {
	return typeof value === 'string' && PII_TYPES.some((piiType) => piiType === value);
}

function readString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function readNullableString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function uniquePiiTypes(value: unknown): PIIType[] {
	const types = Array.isArray(value) ? value : [];
	const unique = new Set<PIIType>();
	for (const item of types) {
		if (isPIIType(item)) {
			unique.add(item);
		}
	}
	return [...unique].sort();
}

export function defaultSensitivityMetadata(
	level: SensitivityLevel = 'internal',
	options?: {
		reason?: string;
		assignedBy?: SensitivityAssignmentSource;
		assignedAt?: string;
		piiTypes?: readonly PIIType[];
		declassifyDate?: string | null;
	},
): SensitivityMetadata {
	return {
		level,
		reason: options?.reason ?? 'default_policy',
		assignedBy: options?.assignedBy ?? 'policy_rule',
		assignedAt: options?.assignedAt ?? new Date().toISOString(),
		piiTypes: [...new Set(options?.piiTypes ?? [])].sort(),
		declassifyDate: options?.declassifyDate ?? null,
	};
}

export function normalizeSensitivityMetadata(
	value: unknown,
	fallbackLevel: SensitivityLevel = 'internal',
): SensitivityMetadata {
	const root = isRecord(value) ? value : {};
	const levelValue = root.level;
	const level = isSensitivityLevel(levelValue) ? levelValue : fallbackLevel;
	const assignedByValue = root.assignedBy ?? root.assigned_by;
	const assignedAt = readString(root.assignedAt ?? root.assigned_at, new Date().toISOString());

	return {
		level,
		reason: readString(root.reason, 'default_policy'),
		assignedBy: isSensitivityAssignmentSource(assignedByValue) ? assignedByValue : 'policy_rule',
		assignedAt,
		piiTypes: uniquePiiTypes(root.piiTypes ?? root.pii_types),
		declassifyDate: readNullableString(root.declassifyDate ?? root.declassify_date),
	};
}

export function mostRestrictiveSensitivityLevel(
	levels: readonly (SensitivityLevel | null | undefined)[],
	fallback: SensitivityLevel = 'internal',
): SensitivityLevel {
	let result = fallback;
	for (const level of levels) {
		if (!level) {
			continue;
		}
		const currentRank = SENSITIVITY_RANK.get(result) ?? 0;
		const nextRank = SENSITIVITY_RANK.get(level) ?? 0;
		if (nextRank > currentRank) {
			result = level;
		}
	}
	return result;
}

export function mergeSensitivityMetadata(
	items: readonly (SensitivityMetadata | unknown | null | undefined)[],
	fallbackLevel: SensitivityLevel = 'internal',
): SensitivityMetadata {
	const normalized = items.map((item) => normalizeSensitivityMetadata(item, fallbackLevel));
	const level = mostRestrictiveSensitivityLevel(
		normalized.map((item) => item.level),
		fallbackLevel,
	);
	const piiTypes = new Set<PIIType>();
	const reasons = new Set<string>();
	let assignedBy: SensitivityAssignmentSource = 'policy_rule';

	for (const item of normalized) {
		for (const piiType of item.piiTypes) {
			piiTypes.add(piiType);
		}
		reasons.add(item.reason);
		if (item.assignedBy === 'human') {
			assignedBy = 'human';
		} else if (assignedBy !== 'human' && item.assignedBy === 'llm_auto') {
			assignedBy = 'llm_auto';
		}
	}

	return defaultSensitivityMetadata(level, {
		reason: [...reasons].sort().join('+') || 'default_policy',
		assignedBy,
		piiTypes: [...piiTypes].sort(),
	});
}

export function mapSensitivityMetadataToDb(value: SensitivityMetadata): Record<string, unknown> {
	return {
		level: value.level,
		reason: value.reason,
		assigned_by: value.assignedBy,
		assigned_at: value.assignedAt,
		pii_types: value.piiTypes,
		declassify_date: value.declassifyDate,
	};
}

export function stringifySensitivityMetadata(value?: unknown, fallbackLevel: SensitivityLevel = 'internal'): string {
	return JSON.stringify(mapSensitivityMetadataToDb(normalizeSensitivityMetadata(value, fallbackLevel)));
}
