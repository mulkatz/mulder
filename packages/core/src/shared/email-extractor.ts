import { createHash } from 'node:crypto';
import type { AttachmentData, FieldsData } from '@kenjiuno/msgreader';
import * as MsgReaderModule from '@kenjiuno/msgreader/lib/MsgReader.js';
import type { AddressObject } from 'mailparser';
import { simpleParser } from 'mailparser';
import { MulderError } from './errors.js';
import type {
	EmailAddress,
	EmailAttachment,
	EmailExtractionResult,
	EmailExtractorService,
	EmailFormat,
	EmailHeaders,
} from './services.js';

type MsgReaderInstance = {
	getFileData(): FieldsData;
	getAttachment(attach: number | FieldsData): AttachmentData;
};

const MsgReader = MsgReaderModule.default.default;

function cleanString(value: string | null | undefined): string | null {
	const normalized = value?.replace(/\s+/g, ' ').trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeMessageId(value: string | null | undefined): string | null {
	const normalized = cleanString(value);
	return normalized ? normalized.replace(/^<|>$/g, '').toLowerCase() : null;
}

function normalizeAddress(input: { name?: string | null; address?: string | null }): EmailAddress | null {
	const address = cleanString(input.address);
	const name = cleanString(input.name);
	if (!address) {
		return null;
	}
	return {
		name,
		address,
		display: name ? `${name} <${address}>` : address,
	};
}

function parseAddressHeader(raw: string | null | undefined): EmailAddress[] {
	const value = cleanString(raw);
	if (!value) {
		return [];
	}
	return value
		.split(',')
		.map((part) => {
			const trimmed = part.trim();
			const match = trimmed.match(/^(?:"?([^"]*?)"?\s*)?<([^<>@\s]+@[^<>\s]+)>$/);
			if (match?.[2]) {
				return normalizeAddress({ name: match[1], address: match[2] });
			}
			const bare = trimmed.match(/[^\s<>@]+@[^\s<>@]+/);
			return bare ? normalizeAddress({ address: bare[0] }) : null;
		})
		.filter((address): address is EmailAddress => address !== null);
}

function headerValue(headers: Map<string, unknown>, key: string): string | null {
	const value = headers.get(key.toLowerCase());
	if (typeof value === 'string') {
		return cleanString(value);
	}
	if (Array.isArray(value)) {
		return cleanString(value.map(String).join(' '));
	}
	return null;
}

function normalizeAddressObject(addressObject: AddressObject | AddressObject[] | undefined): EmailAddress[] {
	const objects = Array.isArray(addressObject) ? addressObject : addressObject ? [addressObject] : [];
	return objects
		.flatMap((object) => object.value)
		.map(normalizeAddress)
		.filter((address): address is EmailAddress => address !== null);
}

function normalizeReferences(values: string | string[] | null | undefined): string[] {
	const joined = Array.isArray(values) ? values.join(' ') : values;
	const normalized = cleanString(joined);
	if (!normalized) {
		return [];
	}
	const angleMatches = [...normalized.matchAll(/<([^<>]+)>/g)].map((match) => normalizeMessageId(match[1]));
	const refs = angleMatches.length > 0 ? angleMatches : normalized.split(/\s+/).map(normalizeMessageId);
	return [...new Set(refs.filter((value): value is string => value !== null))];
}

function deriveThreadId(input: {
	references: string[];
	inReplyTo: string | null;
	messageId: string | null;
	from: EmailAddress[];
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	subject: string | null;
	sentAt: string | null;
}): string {
	const rootReference = input.references[0];
	const basis =
		rootReference ??
		input.inReplyTo ??
		input.messageId ??
		[
			input.from.map((address) => address.address.toLowerCase()).join(','),
			[...input.to, ...input.cc, ...input.bcc]
				.map((address) => address.address.toLowerCase())
				.sort()
				.join(','),
			input.subject
				?.toLowerCase()
				.replace(/^re:\s*/i, '')
				.trim() ?? '',
			input.sentAt ?? '',
		].join('|');
	return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

function stripHtml(html: string | false | null | undefined): string | null {
	if (!html || typeof html !== 'string') {
		return null;
	}
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return text.length > 0 ? text : null;
}

function assertMessageShape(headers: EmailHeaders, bodyText: string, sourceId: string, format: EmailFormat): void {
	const hasHeaderEvidence =
		headers.from.length > 0 || headers.sentAt !== null || headers.messageId !== null || headers.subject !== null;
	if (!hasHeaderEvidence || bodyText.trim().length === 0) {
		throw new MulderError(
			`Email ${format.toUpperCase()} is missing required message headers or body for ${sourceId}`,
			'EMAIL_INVALID',
			{
				context: { sourceId, email_format: format },
			},
		);
	}
}

function buildHeaders(input: {
	messageId: string | null;
	subject: string | null;
	from: EmailAddress[];
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	replyTo: EmailAddress[];
	sentAt: string | null;
	inReplyTo: string | null;
	references: string[];
}): EmailHeaders {
	const headersWithoutThread = {
		messageId: input.messageId,
		subject: input.subject,
		from: input.from,
		to: input.to,
		cc: input.cc,
		bcc: input.bcc,
		replyTo: input.replyTo,
		sentAt: input.sentAt,
		inReplyTo: input.inReplyTo,
		references: input.references,
	};
	return {
		...headersWithoutThread,
		threadId: deriveThreadId(headersWithoutThread),
	};
}

async function parseEml(documentContent: Buffer, sourceId: string): Promise<EmailExtractionResult> {
	let parsed: Awaited<ReturnType<typeof simpleParser>>;
	try {
		parsed = await simpleParser(documentContent);
	} catch (cause: unknown) {
		throw new MulderError(`EML message could not be parsed for source ${sourceId}`, 'EMAIL_INVALID', {
			cause,
			context: { sourceId, email_format: 'eml' },
		});
	}

	const sentDate =
		parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : null;
	const references = normalizeReferences(parsed.references ?? headerValue(parsed.headers, 'references'));
	const headers = buildHeaders({
		messageId: normalizeMessageId(parsed.messageId ?? headerValue(parsed.headers, 'message-id')),
		subject: cleanString(parsed.subject),
		from: normalizeAddressObject(parsed.from),
		to: normalizeAddressObject(parsed.to),
		cc: normalizeAddressObject(parsed.cc),
		bcc: normalizeAddressObject(parsed.bcc),
		replyTo: normalizeAddressObject(parsed.replyTo),
		sentAt: sentDate,
		inReplyTo: normalizeMessageId(headerValue(parsed.headers, 'in-reply-to')),
		references,
	});
	const htmlText = stripHtml(parsed.html);
	const bodyText = cleanString(parsed.text) ?? htmlText ?? '';

	assertMessageShape(headers, bodyText, sourceId, 'eml');

	return {
		emailFormat: 'eml',
		container: 'rfc822_mime',
		parserEngine: 'mailparser',
		headers,
		bodyText,
		bodyHtmlText: htmlText,
		attachments: parsed.attachments.map(
			(attachment): EmailAttachment => ({
				filename: cleanString(attachment.filename),
				mediaType: cleanString(attachment.contentType),
				sizeBytes: attachment.size,
				disposition: cleanString(attachment.contentDisposition),
				contentId: cleanString(attachment.cid),
				content: attachment.content,
			}),
		),
		warnings: [],
	};
}

function msgDate(value: string | undefined): string | null {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function msgAddress(field: FieldsData): EmailAddress | null {
	return normalizeAddress({ name: field.name, address: field.smtpAddress ?? field.email });
}

function parseMsg(documentContent: Buffer, sourceId: string): EmailExtractionResult {
	let data: FieldsData;
	let reader: MsgReaderInstance;
	try {
		reader = new MsgReader(
			new DataView(documentContent.buffer, documentContent.byteOffset, documentContent.byteLength),
		);
		data = reader.getFileData();
	} catch (cause: unknown) {
		throw new MulderError(`MSG message could not be parsed for source ${sourceId}`, 'EMAIL_INVALID', {
			cause,
			context: { sourceId, email_format: 'msg' },
		});
	}

	if (data.error) {
		throw new MulderError(`MSG parser rejected source ${sourceId}: ${data.error}`, 'EMAIL_INVALID', {
			context: { sourceId, email_format: 'msg' },
		});
	}

	const headerText = data.headers ?? '';
	const headerMap = new Map<string, unknown>();
	for (const line of headerText.split(/\r?\n/)) {
		const match = line.match(/^([^:\s]+):\s*(.+)$/);
		if (match?.[1] && match[2]) {
			headerMap.set(match[1].toLowerCase(), match[2]);
		}
	}

	const recipients = data.recipients ?? [];
	const sender = normalizeAddress({
		name: data.senderName,
		address: data.senderSmtpAddress ?? data.senderEmail ?? data.creatorSMTPAddress,
	});
	const headers = buildHeaders({
		messageId: normalizeMessageId(headerValue(headerMap, 'message-id')),
		subject: cleanString(data.subject ?? headerValue(headerMap, 'subject')),
		from: sender ? [sender] : parseAddressHeader(headerValue(headerMap, 'from')),
		to: recipients
			.filter((recipient) => recipient.recipType === 'to')
			.map(msgAddress)
			.filter((address): address is EmailAddress => address !== null),
		cc: recipients
			.filter((recipient) => recipient.recipType === 'cc')
			.map(msgAddress)
			.filter((address): address is EmailAddress => address !== null),
		bcc: recipients
			.filter((recipient) => recipient.recipType === 'bcc')
			.map(msgAddress)
			.filter((address): address is EmailAddress => address !== null),
		replyTo: parseAddressHeader(headerValue(headerMap, 'reply-to')),
		sentAt:
			msgDate(data.clientSubmitTime) ??
			msgDate(data.messageDeliveryTime) ??
			msgDate(headerValue(headerMap, 'date') ?? undefined),
		inReplyTo: normalizeMessageId(headerValue(headerMap, 'in-reply-to')),
		references: normalizeReferences(headerValue(headerMap, 'references')),
	});
	const htmlText = stripHtml(data.bodyHtml);
	const bodyText = cleanString(data.body) ?? htmlText ?? '';
	assertMessageShape(headers, bodyText, sourceId, 'msg');

	const attachments: EmailAttachment[] = [];
	for (const attachment of data.attachments ?? []) {
		let content: Buffer | undefined;
		try {
			const resolved = reader.getAttachment(attachment);
			content = Buffer.from(resolved.content);
		} catch {
			content = undefined;
		}
		attachments.push({
			filename: cleanString(attachment.fileName ?? attachment.fileNameShort ?? attachment.name),
			mediaType: null,
			sizeBytes: content?.length ?? attachment.contentLength ?? 0,
			disposition: null,
			contentId: cleanString(attachment.pidContentId),
			content,
		});
	}

	return {
		emailFormat: 'msg',
		container: 'outlook_msg',
		parserEngine: 'msgreader',
		headers,
		bodyText,
		bodyHtmlText: htmlText,
		attachments,
		warnings: [],
	};
}

class LocalEmailExtractorService implements EmailExtractorService {
	async extractEmail(documentContent: Buffer, sourceId: string, format: EmailFormat): Promise<EmailExtractionResult> {
		return format === 'eml' ? await parseEml(documentContent, sourceId) : parseMsg(documentContent, sourceId);
	}
}

export function createEmailExtractorService(): EmailExtractorService {
	return new LocalEmailExtractorService();
}
