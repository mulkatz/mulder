import { inflateRawSync } from 'node:zlib';
import mammoth from 'mammoth';
import { MulderError } from './errors.js';
import type { Logger } from './logger.js';
import type {
	OfficeDocumentExtractionMessage,
	OfficeDocumentExtractionResult,
	OfficeDocumentExtractorService,
} from './services.js';

interface MammothMarkdownOptions {
	styleMap: string[];
	includeDefaultStyleMap: boolean;
	ignoreEmptyParagraphs: boolean;
	externalFileAccess: boolean;
}

interface MammothMarkdownMessage {
	type: 'warning' | 'error';
	message: string;
}

interface MammothMarkdownResult {
	value: string;
	messages: MammothMarkdownMessage[];
}

interface MammothMarkdownModule {
	convertToMarkdown(input: { buffer: Buffer }, options: MammothMarkdownOptions): Promise<MammothMarkdownResult>;
}

const markdownStyleMap = [
	"p[style-name='Title'] => h1:fresh",
	"p[style-name='Subtitle'] => p:fresh",
	"p[style-name='Heading 1'] => h1:fresh",
	"p[style-name='Heading 2'] => h2:fresh",
	"p[style-name='Heading 3'] => h3:fresh",
];

function findEndOfCentralDirectoryOffset(buffer: Buffer): number {
	const signature = 0x06054b50;
	const maxCommentLength = 0xffff;
	const start = Math.max(0, buffer.length - (maxCommentLength + 22));

	for (let offset = buffer.length - 22; offset >= start; offset--) {
		if (buffer.readUInt32LE(offset) === signature) {
			return offset;
		}
	}

	return -1;
}

function extractZipEntry(buffer: Buffer, targetName: string): Buffer | null {
	const eocdOffset = findEndOfCentralDirectoryOffset(buffer);
	if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) {
		return null;
	}

	const entryCount = buffer.readUInt16LE(eocdOffset + 10);
	const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
	let offset = centralDirectoryOffset;

	for (let index = 0; index < entryCount && offset + 46 <= buffer.length; index++) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) {
			return null;
		}

		const compressionMethod = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const filenameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localHeaderOffset = buffer.readUInt32LE(offset + 42);
		const filenameStart = offset + 46;
		const filenameEnd = filenameStart + filenameLength;
		if (filenameEnd > buffer.length) {
			return null;
		}

		const filename = buffer.subarray(filenameStart, filenameEnd).toString('utf8').replaceAll('\\', '/');
		if (filename === targetName) {
			if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
				return null;
			}
			const localFilenameLength = buffer.readUInt16LE(localHeaderOffset + 26);
			const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
			const dataStart = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
			const dataEnd = dataStart + compressedSize;
			if (dataEnd > buffer.length) {
				return null;
			}
			const compressed = buffer.subarray(dataStart, dataEnd);
			if (compressionMethod === 0) {
				return compressed;
			}
			if (compressionMethod === 8) {
				return inflateRawSync(compressed);
			}
			return null;
		}

		offset = filenameEnd + extraLength + commentLength;
	}

	return null;
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

function readDocxCoreTitle(buffer: Buffer): string | undefined {
	const coreProperties = extractZipEntry(buffer, 'docProps/core.xml');
	if (!coreProperties) {
		return undefined;
	}

	const xml = coreProperties.toString('utf8');
	const titleMatch = xml.match(/<dc:title>([\s\S]*?)<\/dc:title>/i);
	if (!titleMatch?.[1]) {
		return undefined;
	}

	const title = decodeXmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
	return title.length > 0 ? title : undefined;
}

function normalizeMarkdownLineEndings(markdown: string): string {
	return markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function stripMarkdownInlineSyntax(value: string): string {
	return value
		.replace(/[`*_~[\]()]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function titleFromMarkdownHeading(markdown: string): string | undefined {
	const heading = markdown.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
	if (!heading?.[1]) {
		return undefined;
	}
	const title = stripMarkdownInlineSyntax(heading[1]);
	return title.length > 0 ? title : undefined;
}

function hasVisibleText(markdown: string): boolean {
	const visibleText = markdown
		.replace(/!\[[^\]]*]\([^)]*\)/g, '')
		.replace(/\[[^\]]+]\([^)]*\)/g, '')
		.replace(/[`*_~#>\-[\]()|:]/g, '')
		.replace(/\s+/g, '');
	return visibleText.length > 0;
}

function normalizeMammothMessages(messages: MammothMarkdownMessage[]): OfficeDocumentExtractionMessage[] {
	return messages.map((message) => ({
		type: message.type,
		message: message.message,
	}));
}

class MammothOfficeDocumentExtractorService implements OfficeDocumentExtractorService {
	private readonly mammothMarkdown: MammothMarkdownModule;

	constructor(private readonly logger: Logger) {
		// Mammoth ships convertToMarkdown at runtime, but its declaration file
		// omits it. Keep the bridge localized to this adapter.
		this.mammothMarkdown = mammoth as unknown as MammothMarkdownModule;
	}

	async extractDocx(documentContent: Buffer, sourceId: string): Promise<OfficeDocumentExtractionResult> {
		let result: MammothMarkdownResult;
		try {
			result = await this.mammothMarkdown.convertToMarkdown(
				{ buffer: documentContent },
				{
					styleMap: markdownStyleMap,
					includeDefaultStyleMap: true,
					ignoreEmptyParagraphs: true,
					externalFileAccess: false,
				},
			);
		} catch (cause: unknown) {
			throw new MulderError(`DOCX extraction failed for source ${sourceId}`, 'OFFICE_DOCUMENT_EXTRACT_FAILED', {
				cause,
				context: { sourceId, extraction_engine: 'mammoth' },
			});
		}

		const markdown = normalizeMarkdownLineEndings(result.value);
		if (!hasVisibleText(markdown)) {
			throw new MulderError(
				`DOCX extraction produced no readable content for source ${sourceId}`,
				'OFFICE_DOCUMENT_EMPTY',
				{
					context: { sourceId, extraction_engine: 'mammoth' },
				},
			);
		}

		this.logger.debug(
			{ sourceId, warningCount: result.messages.length, markdownBytes: Buffer.byteLength(markdown, 'utf-8') },
			'Office DOCX converted to Markdown',
		);

		return {
			markdown,
			title: titleFromMarkdownHeading(markdown) ?? readDocxCoreTitle(documentContent),
			extractionEngine: 'mammoth',
			messages: normalizeMammothMessages(result.messages),
		};
	}
}

export function createOfficeDocumentExtractorService(logger: Logger): OfficeDocumentExtractorService {
	return new MammothOfficeDocumentExtractorService(logger);
}
