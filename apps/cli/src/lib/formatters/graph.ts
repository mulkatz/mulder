/**
 * Graph export format converters.
 *
 * Pure functions: (data) => string. No side effects, no DB calls.
 * Each function takes graph nodes, edges, and alias maps, and returns
 * a formatted string in the target format.
 *
 * @see docs/specs/53_export_commands.spec.md §4.2, §4.6, §4.7
 */

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface GraphExportNode {
	id: string;
	name: string;
	type: string;
	canonicalId: string | null;
	corroborationScore: number | null;
	sourceCount: number;
	taxonomyStatus: string;
	aliases: string[];
	attributes: Record<string, unknown>;
}

export interface GraphExportEdge {
	id: string;
	sourceEntityId: string;
	targetEntityId: string;
	relationship: string;
	edgeType: string;
	confidence: number | null;
	storyId: string | null;
	attributes: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// JSON
// ────────────────────────────────────────────────────────────

export function formatGraphJson(nodes: GraphExportNode[], edges: GraphExportEdge[]): string {
	const output = {
		nodes,
		edges,
		metadata: {
			exportedAt: new Date().toISOString(),
			nodeCount: nodes.length,
			edgeCount: edges.length,
		},
	};
	return JSON.stringify(output, null, 2);
}

// ────────────────────────────────────────────────────────────
// CSV
// ────────────────────────────────────────────────────────────

/** Escapes a CSV field value. Wraps in quotes if it contains commas, quotes, or newlines. */
function escapeCsv(value: string): string {
	if (value.includes(',') || value.includes('"') || value.includes('\n')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function formatGraphCsv(nodes: GraphExportNode[], edges: GraphExportEdge[]): string {
	const lines: string[] = [];

	// Nodes section
	lines.push('## Nodes');
	lines.push('id,name,type,canonicalId,corroborationScore,sourceCount,taxonomyStatus,aliases');
	for (const node of nodes) {
		lines.push(
			[
				escapeCsv(node.id),
				escapeCsv(node.name),
				escapeCsv(node.type),
				escapeCsv(node.canonicalId ?? ''),
				node.corroborationScore !== null ? String(node.corroborationScore) : '',
				String(node.sourceCount),
				escapeCsv(node.taxonomyStatus),
				escapeCsv(node.aliases.join(';')),
			].join(','),
		);
	}

	// Blank line separator
	lines.push('');

	// Edges section
	lines.push('## Edges');
	lines.push('id,sourceEntityId,targetEntityId,relationship,edgeType,confidence,storyId');
	for (const edge of edges) {
		lines.push(
			[
				escapeCsv(edge.id),
				escapeCsv(edge.sourceEntityId),
				escapeCsv(edge.targetEntityId),
				escapeCsv(edge.relationship),
				escapeCsv(edge.edgeType),
				edge.confidence !== null ? String(edge.confidence) : '',
				escapeCsv(edge.storyId ?? ''),
			].join(','),
		);
	}

	return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
// GraphML
// ────────────────────────────────────────────────────────────

/** Escapes special XML characters. */
function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export function formatGraphMl(nodes: GraphExportNode[], edges: GraphExportEdge[]): string {
	const lines: string[] = [];

	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push('<graphml xmlns="http://graphml.graphstruct.org/graphml"');
	lines.push('         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
	lines.push('         xsi:schemaLocation="http://graphml.graphstruct.org/graphml');
	lines.push('         http://graphml.graphstruct.org/graphml/1.0/graphml.xsd">');

	// Key definitions for node attributes
	lines.push('  <key id="name" for="node" attr.name="name" attr.type="string"/>');
	lines.push('  <key id="type" for="node" attr.name="type" attr.type="string"/>');
	lines.push('  <key id="canonicalId" for="node" attr.name="canonicalId" attr.type="string"/>');
	lines.push('  <key id="corroborationScore" for="node" attr.name="corroborationScore" attr.type="double"/>');
	lines.push('  <key id="sourceCount" for="node" attr.name="sourceCount" attr.type="int"/>');
	lines.push('  <key id="taxonomyStatus" for="node" attr.name="taxonomyStatus" attr.type="string"/>');
	lines.push('  <key id="aliases" for="node" attr.name="aliases" attr.type="string"/>');

	// Key definitions for edge attributes
	lines.push('  <key id="relationship" for="edge" attr.name="relationship" attr.type="string"/>');
	lines.push('  <key id="edgeType" for="edge" attr.name="edgeType" attr.type="string"/>');
	lines.push('  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>');

	lines.push('  <graph id="mulder" edgedefault="directed">');

	// Nodes
	for (const node of nodes) {
		lines.push(`    <node id="${escapeXml(node.id)}">`);
		lines.push(`      <data key="name">${escapeXml(node.name)}</data>`);
		lines.push(`      <data key="type">${escapeXml(node.type)}</data>`);
		if (node.canonicalId !== null) {
			lines.push(`      <data key="canonicalId">${escapeXml(node.canonicalId)}</data>`);
		}
		if (node.corroborationScore !== null) {
			lines.push(`      <data key="corroborationScore">${node.corroborationScore}</data>`);
		}
		lines.push(`      <data key="sourceCount">${node.sourceCount}</data>`);
		lines.push(`      <data key="taxonomyStatus">${escapeXml(node.taxonomyStatus)}</data>`);
		if (node.aliases.length > 0) {
			lines.push(`      <data key="aliases">${escapeXml(node.aliases.join(';'))}</data>`);
		}
		lines.push('    </node>');
	}

	// Edges
	for (const edge of edges) {
		lines.push(
			`    <edge id="${escapeXml(edge.id)}" source="${escapeXml(edge.sourceEntityId)}" target="${escapeXml(edge.targetEntityId)}">`,
		);
		lines.push(`      <data key="relationship">${escapeXml(edge.relationship)}</data>`);
		lines.push(`      <data key="edgeType">${escapeXml(edge.edgeType)}</data>`);
		if (edge.confidence !== null) {
			lines.push(`      <data key="confidence">${edge.confidence}</data>`);
		}
		lines.push('    </edge>');
	}

	lines.push('  </graph>');
	lines.push('</graphml>');

	return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
// Cypher
// ────────────────────────────────────────────────────────────

/** Escapes a Cypher string value (single-quoted). */
function escapeCypher(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function formatGraphCypher(nodes: GraphExportNode[], edges: GraphExportEdge[]): string {
	const lines: string[] = [];

	lines.push('// Nodes');
	for (const node of nodes) {
		const props: string[] = [
			`id: '${escapeCypher(node.id)}'`,
			`name: '${escapeCypher(node.name)}'`,
			`type: '${escapeCypher(node.type)}'`,
			`sourceCount: ${node.sourceCount}`,
		];
		if (node.corroborationScore !== null) {
			props.push(`corroborationScore: ${node.corroborationScore}`);
		}
		if (node.canonicalId !== null) {
			props.push(`canonicalId: '${escapeCypher(node.canonicalId)}'`);
		}
		if (node.aliases.length > 0) {
			const aliasesStr = node.aliases.map((a) => `'${escapeCypher(a)}'`).join(', ');
			props.push(`aliases: [${aliasesStr}]`);
		}
		lines.push(`CREATE (n:Entity {${props.join(', ')}});`);
	}

	if (edges.length > 0) {
		lines.push('');
		lines.push('// Edges');
		for (const edge of edges) {
			const relName = edge.relationship.replace(/[^a-zA-Z0-9_]/g, '_');
			const props: string[] = [`id: '${escapeCypher(edge.id)}'`, `edgeType: '${escapeCypher(edge.edgeType)}'`];
			if (edge.confidence !== null) {
				props.push(`confidence: ${edge.confidence}`);
			}
			lines.push(
				`MATCH (a:Entity {id: '${escapeCypher(edge.sourceEntityId)}'}), (b:Entity {id: '${escapeCypher(edge.targetEntityId)}'})`,
			);
			lines.push(`CREATE (a)-[:${relName} {${props.join(', ')}}]->(b);`);
		}
	}

	return lines.join('\n');
}
