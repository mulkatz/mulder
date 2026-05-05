import { MulderError } from './errors.js';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const STORAGE_EXTENSION_RE = /^[a-z0-9][a-z0-9-]*$/;

function normalizeExtension(extension?: string | null): string {
	if (!extension) {
		return '';
	}

	const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
	if (!STORAGE_EXTENSION_RE.test(normalized)) {
		throw new MulderError(
			'Blob storage extension must contain only lowercase ASCII letters, digits, or hyphens',
			'VALIDATION_ERROR',
			{
				context: { extension },
			},
		);
	}

	return `.${normalized}`;
}

export function assertSha256ContentHash(contentHash: string): void {
	if (!SHA256_HEX_RE.test(contentHash)) {
		throw new MulderError('Content-addressed blob paths require a lowercase SHA-256 hex hash', 'VALIDATION_ERROR', {
			context: { content_hash: contentHash },
		});
	}
}

export function buildContentAddressedBlobPath(contentHash: string, extension?: string | null): string {
	assertSha256ContentHash(contentHash);
	const suffix = normalizeExtension(extension);
	return `blobs/sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}${suffix}`;
}

export function buildContentAddressedBlobUri(
	bucketNameOrPrefix: string,
	contentHash: string,
	extension?: string | null,
): string {
	const path = buildContentAddressedBlobPath(contentHash, extension);
	const trimmed = bucketNameOrPrefix.replace(/\/+$/g, '');
	if (trimmed.startsWith('gs://') || trimmed.includes('://')) {
		return `${trimmed}/${path}`;
	}
	return `gs://${trimmed}/${path}`;
}
