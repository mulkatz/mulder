export function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function objectToJsonRecord(value: object): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value));
}

export function unknownToJsonRecord(value: unknown): Record<string, unknown> {
	return isJsonRecord(value) ? { ...value } : {};
}
