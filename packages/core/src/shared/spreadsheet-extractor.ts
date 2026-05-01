import { TextDecoder } from 'node:util';
import * as XLSX from 'xlsx';
import { MulderError } from './errors.js';
import type {
	SpreadsheetExtractionResult,
	SpreadsheetExtractorService,
	SpreadsheetRowGroup,
	SpreadsheetSheet,
	SpreadsheetTabularFormat,
} from './services.js';

const ROW_GROUP_SIZE = 200;
const CSV_DELIMITERS = [',', ';', '\t'] as const;

type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

function decodeUtf8(buffer: Buffer, sourceId: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
	} catch (cause: unknown) {
		throw new MulderError(`CSV spreadsheet is not readable UTF-8 for source ${sourceId}`, 'SPREADSHEET_INVALID', {
			cause,
			context: { sourceId, tabular_format: 'csv' },
		});
	}
}

function parseDelimitedRows(text: string, delimiter: CsvDelimiter): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let inQuotes = false;

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];

		if (char === '"') {
			if (inQuotes && next === '"') {
				cell += '"';
				index++;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (!inQuotes && char === delimiter) {
			row.push(cell);
			cell = '';
			continue;
		}

		if (!inQuotes && (char === '\n' || char === '\r')) {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			if (char === '\r' && next === '\n') {
				index++;
			}
			continue;
		}

		cell += char;
	}

	row.push(cell);
	rows.push(row);
	return rows;
}

function isNonEmptyRow(row: string[]): boolean {
	return row.some((cell) => cell.trim().length > 0);
}

function normalizeCell(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}
	return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function normalizeHeader(value: string, index: number, used: Set<string>): string {
	const base = value.trim().replace(/\s+/g, ' ') || `Column ${index + 1}`;
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base} ${suffix}`;
		suffix++;
	}
	used.add(candidate);
	return candidate;
}

function normalizeRows(rows: string[][]): { headers: string[]; dataRows: string[][] } | null {
	const visibleRows = rows.map((row) => row.map(normalizeCell)).filter(isNonEmptyRow);
	if (visibleRows.length < 2) {
		return null;
	}

	const columnCount = Math.max(...visibleRows.map((row) => row.length));
	if (columnCount < 2) {
		return null;
	}

	const usedHeaders = new Set<string>();
	const headerRow = visibleRows[0] ?? [];
	const headers = Array.from({ length: columnCount }, (_, index) =>
		normalizeHeader(headerRow[index] ?? '', index, usedHeaders),
	);
	const dataRows = visibleRows
		.slice(1)
		.map((row) => Array.from({ length: columnCount }, (_, index) => normalizeCell(row[index] ?? '')))
		.filter(isNonEmptyRow);

	return dataRows.length > 0 ? { headers, dataRows } : null;
}

function buildRowGroups(rowCount: number): SpreadsheetRowGroup[] {
	const groups: SpreadsheetRowGroup[] = [];
	for (let start = 1; start <= rowCount; start += ROW_GROUP_SIZE) {
		const end = Math.min(rowCount, start + ROW_GROUP_SIZE - 1);
		groups.push({
			index: groups.length,
			rowStart: start,
			rowEnd: end,
		});
	}
	return groups;
}

function buildSheet(name: string, headers: string[], rows: string[][]): SpreadsheetSheet {
	const rowGroups = buildRowGroups(rows.length);
	return {
		name,
		headers,
		rows,
		rowGroups,
		summary: {
			sheetName: name,
			rowCount: rows.length,
			columnCount: headers.length,
			rowGroupCount: rowGroups.length,
		},
	};
}

function detectCsvDelimiter(text: string): CsvDelimiter | null {
	let best: { delimiter: CsvDelimiter; score: number } | null = null;
	for (const delimiter of CSV_DELIMITERS) {
		const parsed = parseDelimitedRows(text, delimiter).filter(isNonEmptyRow);
		if (parsed.length < 2) {
			continue;
		}
		const firstCount = parsed[0]?.length ?? 0;
		const consistentRows = parsed.filter((row) => row.length === firstCount).length;
		if (firstCount < 2 || consistentRows < 2) {
			continue;
		}
		const score = consistentRows * firstCount;
		if (!best || score > best.score) {
			best = { delimiter, score };
		}
	}
	return best?.delimiter ?? null;
}

function parseCsv(buffer: Buffer, sourceId: string): SpreadsheetExtractionResult {
	const text = decodeUtf8(buffer, sourceId);
	const delimiter = detectCsvDelimiter(text);
	if (!delimiter) {
		throw new MulderError(`CSV spreadsheet has no consistent delimiter for source ${sourceId}`, 'SPREADSHEET_INVALID', {
			context: { sourceId, tabular_format: 'csv' },
		});
	}

	const normalized = normalizeRows(parseDelimitedRows(text, delimiter));
	if (!normalized) {
		throw new MulderError(`CSV spreadsheet has no data rows for source ${sourceId}`, 'SPREADSHEET_EMPTY', {
			context: { sourceId, tabular_format: 'csv' },
		});
	}

	const sheet = buildSheet('CSV', normalized.headers, normalized.dataRows);
	return {
		tabularFormat: 'csv',
		parserEngine: 'mulder-csv',
		delimiter,
		sheets: [sheet],
		sheetSummaries: [sheet.summary],
		warnings: [],
	};
}

function worksheetRows(worksheet: XLSX.WorkSheet): string[][] {
	const rawRows: unknown[][] = XLSX.utils.sheet_to_json(worksheet, {
		header: 1,
		defval: '',
		blankrows: false,
		raw: false,
	});
	return rawRows.map((row) => row.map(normalizeCell));
}

function parseXlsx(buffer: Buffer, sourceId: string): SpreadsheetExtractionResult {
	let workbook: XLSX.WorkBook;
	try {
		workbook = XLSX.read(buffer, {
			type: 'buffer',
			cellDates: true,
			raw: false,
		});
	} catch (cause: unknown) {
		throw new MulderError(`XLSX spreadsheet could not be parsed for source ${sourceId}`, 'SPREADSHEET_INVALID', {
			cause,
			context: { sourceId, tabular_format: 'xlsx' },
		});
	}

	const sheets: SpreadsheetSheet[] = [];
	for (const sheetName of workbook.SheetNames) {
		const worksheet = workbook.Sheets[sheetName];
		if (!worksheet) {
			continue;
		}
		const normalized = normalizeRows(worksheetRows(worksheet));
		if (!normalized) {
			continue;
		}
		sheets.push(buildSheet(sheetName, normalized.headers, normalized.dataRows));
	}

	if (sheets.length === 0) {
		throw new MulderError(`XLSX spreadsheet has no non-empty sheets for source ${sourceId}`, 'SPREADSHEET_EMPTY', {
			context: { sourceId, tabular_format: 'xlsx' },
		});
	}

	return {
		tabularFormat: 'xlsx',
		parserEngine: 'sheetjs-xlsx',
		sheets,
		sheetSummaries: sheets.map((sheet) => sheet.summary),
		warnings: [],
	};
}

class LocalSpreadsheetExtractorService implements SpreadsheetExtractorService {
	async extractSpreadsheet(
		documentContent: Buffer,
		sourceId: string,
		format: SpreadsheetTabularFormat,
	): Promise<SpreadsheetExtractionResult> {
		return format === 'csv' ? parseCsv(documentContent, sourceId) : parseXlsx(documentContent, sourceId);
	}
}

export function createSpreadsheetExtractorService(): SpreadsheetExtractorService {
	return new LocalSpreadsheetExtractorService();
}
