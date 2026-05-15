export interface IntakeEnrichmentSuggestion {
	id: string;
	sourceId: string;
	storagePath: string;
	filename: string;
	fileHash: string | null;
	model: string;
	promptVersion: string;
	suggestedPayload: Record<string, unknown>;
	fieldConfidence: Record<string, unknown>;
	warnings: string[];
	requestedBy: Record<string, unknown>;
	createdAt: Date;
}

export interface CreateIntakeEnrichmentSuggestionInput {
	sourceId: string;
	storagePath: string;
	filename: string;
	fileHash?: string | null;
	model: string;
	promptVersion: string;
	suggestedPayload: Record<string, unknown>;
	fieldConfidence?: Record<string, unknown>;
	warnings?: string[];
	requestedBy?: Record<string, unknown>;
}
