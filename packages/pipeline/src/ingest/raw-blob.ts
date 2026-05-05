import type { Services } from '@mulder/core';
import { buildContentAddressedBlobPath, findDocumentBlobByHash, upsertDocumentBlob } from '@mulder/core';
import type pg from 'pg';

export async function ensureRawDocumentBlob(input: {
	services: Services;
	pool: pg.Pool;
	contentHash: string;
	content: Buffer;
	mediaType: string;
	storageExtension: string;
	filename: string;
}): Promise<string> {
	const existingBlob = await findDocumentBlobByHash(input.pool, input.contentHash);
	if (existingBlob) {
		await upsertDocumentBlob(input.pool, {
			contentHash: input.contentHash,
			storagePath: existingBlob.storagePath,
			storageUri: existingBlob.storageUri,
			mimeType: existingBlob.mimeType,
			fileSizeBytes: existingBlob.fileSizeBytes,
			originalFilenames: [input.filename],
		});
		return existingBlob.storagePath;
	}

	const storagePath = buildContentAddressedBlobPath(input.contentHash, input.storageExtension);
	const exists = await input.services.storage.exists(storagePath);
	let uploadedAlternate = false;
	if (!exists) {
		await input.services.storage.upload(storagePath, input.content, input.mediaType);
		uploadedAlternate = true;
	}

	const blob = await upsertDocumentBlob(input.pool, {
		contentHash: input.contentHash,
		storagePath,
		storageUri: input.services.storage.buildUri(storagePath),
		mimeType: input.mediaType,
		fileSizeBytes: input.content.byteLength,
		originalFilenames: [input.filename],
	});

	if (uploadedAlternate && blob.storagePath !== storagePath) {
		await input.services.storage.delete(storagePath);
	}

	return blob.storagePath;
}
