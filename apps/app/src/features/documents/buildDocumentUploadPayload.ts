import type {
	SensitivityLevel,
	UploadAcquisitionChannel,
	UploadAuthenticityStatus,
	UploadOriginalSourceType,
} from '@/lib/api-types';
import type { DocumentUploadPayload } from './useDocumentUpload';

export interface BuildDocumentUploadPayloadInput {
	acquisitionNotes: string;
	authenticityNotes: string;
	authenticityStatus: UploadAuthenticityStatus | '';
	channel: UploadAcquisitionChannel | '';
	collectionId: string;
	custodian: string;
	custodyNotes: string;
	intakeSuggestionId?: string;
	noCollectionConfirmed: boolean;
	sensitivityLevel: SensitivityLevel | '';
	sensitivityReason: string;
	sourceDescription: string;
	sourceLanguage: string;
	sourceType: UploadOriginalSourceType | '';
}

export function buildDocumentUploadPayload(input: BuildDocumentUploadPayloadInput): DocumentUploadPayload {
	const trimmedDescription = input.sourceDescription.trim();
	const trimmedLanguage = input.sourceLanguage.trim();
	const trimmedCustodian = input.custodian.trim();
	const trimmedCustodyNotes = input.custodyNotes.trim();
	const trimmedAcquisitionNotes = input.acquisitionNotes.trim();
	const trimmedAuthenticityNotes = input.authenticityNotes.trim();
	const acquisition =
		input.channel || input.collectionId || trimmedAcquisitionNotes || input.noCollectionConfirmed
			? {
					...(input.channel ? { channel: input.channel } : {}),
					collection_id: input.collectionId || null,
					metadata: {
						...(input.intakeSuggestionId ? { intake_suggestion_id: input.intakeSuggestionId } : {}),
						no_collection_confirmed: !input.collectionId && input.noCollectionConfirmed,
					},
					notes: trimmedAcquisitionNotes || null,
				}
			: input.intakeSuggestionId
				? {
						collection_id: input.collectionId || null,
						metadata: {
							intake_suggestion_id: input.intakeSuggestionId,
							no_collection_confirmed: !input.collectionId && input.noCollectionConfirmed,
						},
					}
				: undefined;
	const originalSource =
		trimmedDescription || trimmedLanguage || input.sourceType
			? {
					...(trimmedDescription ? { description: trimmedDescription } : {}),
					...(trimmedLanguage ? { language: trimmedLanguage } : {}),
					source_type: input.sourceType || 'other',
				}
			: undefined;
	const authenticity =
		input.authenticityStatus || trimmedAuthenticityNotes
			? {
					notes: trimmedAuthenticityNotes || null,
					status: input.authenticityStatus || 'unverified',
				}
			: undefined;
	const custodyChain = trimmedCustodian
		? [
				{
					holder: trimmedCustodian,
					holder_type: 'unknown' as const,
					notes: trimmedCustodyNotes || null,
					step_order: 1,
				},
			]
		: undefined;
	return {
		...(input.sensitivityLevel
			? {
					expected_sensitivity: {
						level: input.sensitivityLevel,
						...(input.sensitivityReason.trim() ? { reason: input.sensitivityReason.trim() } : {}),
					},
				}
			: {}),
		provenance: {
			...(acquisition ? { acquisition } : {}),
			...(authenticity ? { authenticity } : {}),
			...(custodyChain ? { custody_chain: custodyChain } : {}),
			...(originalSource ? { original_source: originalSource } : {}),
		},
	};
}
