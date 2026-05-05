export type DocumentQualityAssessmentMethod = 'automated' | 'human';
export type DocumentOverallQuality = 'high' | 'medium' | 'low' | 'unusable';
export type ExtractionPath =
	| 'standard'
	| 'enhanced_ocr'
	| 'visual_extraction'
	| 'handwriting_recognition'
	| 'manual_transcription_required'
	| 'skip';

export type DocumentStructureType =
	| 'printed_text'
	| 'handwritten'
	| 'mixed'
	| 'table'
	| 'form'
	| 'newspaper_clipping'
	| 'photo_of_document'
	| 'diagram';

export interface DocumentQualityDimensions {
	textReadability: {
		score: number;
		method: 'ocr_confidence' | 'llm_visual' | 'n/a';
		details: string;
	};
	imageQuality: {
		score: number;
		issues: string[];
	};
	languageDetection: {
		primaryLanguage: string;
		confidence: number;
		mixedLanguages: boolean;
	};
	documentStructure: {
		type: DocumentStructureType;
		hasAnnotations: boolean;
		hasMarginalia: boolean;
		multiColumn: boolean;
	};
	contentCompleteness: {
		pagesTotal: number;
		pagesReadable: number;
		missingPagesSuspected: boolean;
		truncated: boolean;
	};
}

export type DocumentQualitySignals = Record<string, unknown>;

export interface DocumentQualityAssessment {
	id: string;
	sourceId: string;
	assessedAt: Date;
	assessmentMethod: DocumentQualityAssessmentMethod;
	overallQuality: DocumentOverallQuality;
	processable: boolean;
	recommendedPath: ExtractionPath;
	dimensions: DocumentQualityDimensions;
	signals: DocumentQualitySignals;
	createdAt: Date;
}

export interface CreateDocumentQualityAssessmentInput {
	sourceId: string;
	assessedAt?: Date;
	assessmentMethod: DocumentQualityAssessmentMethod;
	overallQuality: DocumentOverallQuality;
	processable: boolean;
	recommendedPath: ExtractionPath;
	dimensions: DocumentQualityDimensions;
	signals?: DocumentQualitySignals;
}

export interface DocumentQualityOverride {
	assessmentMethod?: DocumentQualityAssessmentMethod;
	overallQuality?: DocumentOverallQuality;
	processable?: boolean;
	recommendedPath?: ExtractionPath;
	dimensions?: Partial<DocumentQualityDimensions> | Record<string, unknown>;
	signals?: DocumentQualitySignals;
}

export interface CompactDocumentQualitySummary {
	source_document_quality: 'high' | 'medium' | 'low';
	extraction_path: ExtractionPath;
	extraction_confidence: number;
	document_quality_assessment_id: string;
}
