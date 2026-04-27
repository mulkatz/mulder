/**
 * Evidence export format converters.
 *
 * Pure functions: (data) => string. No side effects, no DB calls.
 *
 * @see docs/specs/53_export_commands.spec.md §4.2
 */

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type DataReliability = 'insufficient' | 'low' | 'moderate' | 'high';
export type CorroborationStatus = 'scored' | 'not_scored' | 'insufficient_data';

export interface EvidenceEntity {
	id: string;
	name: string;
	type: string;
	corroborationScore: number | null;
	corroborationStatus: CorroborationStatus;
	sourceCount: number;
}

export interface EvidenceEdge {
	id: string;
	sourceEntityId: string;
	targetEntityId: string;
	relationship: string;
	edgeType: string;
	confidence: number | null;
	storyId: string | null;
	attributes: Record<string, unknown>;
}

export interface EvidenceSummary {
	totalEntities: number;
	scoredEntities: number;
	avgCorroboration: number | null;
	corroborationStatus: CorroborationStatus;
	contradictionCount: number;
	duplicateCount: number;
	dataReliability: DataReliability;
}

export interface EvidenceExportData {
	entities: EvidenceEntity[];
	contradictions: EvidenceEdge[];
	duplicates: EvidenceEdge[];
	summary: EvidenceSummary;
}

// ────────────────────────────────────────────────────────────
// JSON
// ────────────────────────────────────────────────────────────

export function formatEvidenceJson(data: EvidenceExportData): string {
	const output = {
		...data,
		metadata: {
			exportedAt: new Date().toISOString(),
		},
	};
	return JSON.stringify(output, null, 2);
}

// ────────────────────────────────────────────────────────────
// CSV
// ────────────────────────────────────────────────────────────

/** Escapes a CSV field value. */
function escapeCsv(value: string): string {
	if (value.includes(',') || value.includes('"') || value.includes('\n')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function formatEvidenceCsv(data: EvidenceExportData): string {
	const lines: string[] = [];

	// Entities section
	lines.push('## Entities with Corroboration Scores');
	lines.push('id,name,type,corroborationScore,corroborationStatus,sourceCount');
	for (const entity of data.entities) {
		lines.push(
			[
				escapeCsv(entity.id),
				escapeCsv(entity.name),
				escapeCsv(entity.type),
				entity.corroborationScore !== null ? String(entity.corroborationScore) : '',
				entity.corroborationStatus,
				String(entity.sourceCount),
			].join(','),
		);
	}

	lines.push('');

	// Contradictions section
	lines.push('## Contradictions');
	lines.push('id,sourceEntityId,targetEntityId,relationship,edgeType,confidence');
	for (const edge of data.contradictions) {
		lines.push(
			[
				escapeCsv(edge.id),
				escapeCsv(edge.sourceEntityId),
				escapeCsv(edge.targetEntityId),
				escapeCsv(edge.relationship),
				escapeCsv(edge.edgeType),
				edge.confidence !== null ? String(edge.confidence) : '',
			].join(','),
		);
	}

	lines.push('');

	// Duplicates section
	lines.push('## Duplicates');
	lines.push('id,sourceEntityId,targetEntityId,relationship,edgeType,confidence');
	for (const edge of data.duplicates) {
		lines.push(
			[
				escapeCsv(edge.id),
				escapeCsv(edge.sourceEntityId),
				escapeCsv(edge.targetEntityId),
				escapeCsv(edge.relationship),
				escapeCsv(edge.edgeType),
				edge.confidence !== null ? String(edge.confidence) : '',
			].join(','),
		);
	}

	lines.push('');

	// Summary section
	lines.push('## Summary');
	lines.push('metric,value');
	lines.push(`totalEntities,${data.summary.totalEntities}`);
	lines.push(`scoredEntities,${data.summary.scoredEntities}`);
	lines.push(`avgCorroboration,${data.summary.avgCorroboration ?? ''}`);
	lines.push(`corroborationStatus,${data.summary.corroborationStatus}`);
	lines.push(`contradictionCount,${data.summary.contradictionCount}`);
	lines.push(`duplicateCount,${data.summary.duplicateCount}`);
	lines.push(`dataReliability,${data.summary.dataReliability}`);

	return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
// Markdown
// ────────────────────────────────────────────────────────────

export function formatEvidenceMarkdown(data: EvidenceExportData): string {
	const lines: string[] = [];

	lines.push('# Evidence Report');
	lines.push('');
	lines.push(`Exported: ${new Date().toISOString()}`);
	lines.push('');

	// Summary
	lines.push('## Summary');
	lines.push('');
	lines.push(`| Metric | Value |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Total Entities | ${data.summary.totalEntities} |`);
	lines.push(`| Scored Entities | ${data.summary.scoredEntities} |`);
	lines.push(
		`| Avg. Corroboration | ${
			data.summary.avgCorroboration !== null ? data.summary.avgCorroboration.toFixed(2) : data.summary.corroborationStatus
		} |`,
	);
	lines.push(`| Corroboration Status | ${data.summary.corroborationStatus} |`);
	lines.push(`| Contradictions | ${data.summary.contradictionCount} |`);
	lines.push(`| Duplicates | ${data.summary.duplicateCount} |`);
	lines.push(`| Data Reliability | ${data.summary.dataReliability} |`);
	lines.push('');

	if (data.summary.dataReliability === 'insufficient' || data.summary.dataReliability === 'low') {
		lines.push(
			`> **Warning:** Data reliability is ${data.summary.dataReliability}. Corroboration scores may not be meaningful with the current corpus size.`,
		);
		lines.push('');
	}

	// Top corroborated entities
	if (data.entities.length > 0) {
		lines.push('## Top Corroborated Entities');
		lines.push('');
		lines.push('| Name | Type | Score | Sources |');
		lines.push('|------|------|-------|---------|');
		const sorted = [...data.entities].sort(
			(a, b) => (b.corroborationScore ?? Number.NEGATIVE_INFINITY) - (a.corroborationScore ?? Number.NEGATIVE_INFINITY),
		);
		const topEntities = sorted.slice(0, 20);
		for (const entity of topEntities) {
			const score = entity.corroborationScore !== null ? entity.corroborationScore.toFixed(2) : entity.corroborationStatus;
			lines.push(
				`| ${entity.name} | ${entity.type} | ${score} | ${entity.sourceCount} |`,
			);
		}
		lines.push('');
	}

	// Contradictions
	if (data.contradictions.length > 0) {
		lines.push('## Contradictions');
		lines.push('');
		lines.push('| Source Entity | Target Entity | Relationship | Type | Confidence |');
		lines.push('|-------------|---------------|-------------|------|-----------|');
		for (const edge of data.contradictions) {
			lines.push(
				`| ${edge.sourceEntityId} | ${edge.targetEntityId} | ${edge.relationship} | ${edge.edgeType} | ${edge.confidence ?? '-'} |`,
			);
		}
		lines.push('');
	} else {
		lines.push('## Contradictions');
		lines.push('');
		lines.push('No contradictions detected.');
		lines.push('');
	}

	// Duplicates
	if (data.duplicates.length > 0) {
		lines.push('## Duplicates');
		lines.push('');
		lines.push('| Source Entity | Target Entity | Relationship | Confidence |');
		lines.push('|-------------|---------------|-------------|-----------|');
		for (const edge of data.duplicates) {
			lines.push(
				`| ${edge.sourceEntityId} | ${edge.targetEntityId} | ${edge.relationship} | ${edge.confidence ?? '-'} |`,
			);
		}
		lines.push('');
	} else {
		lines.push('## Duplicates');
		lines.push('');
		lines.push('No duplicates detected.');
		lines.push('');
	}

	return lines.join('\n');
}
