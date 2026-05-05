import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const PIPELINE_MODULE = resolve(ROOT, 'packages/pipeline/dist/index.js');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');

describe('Spec 16 — Ingest duplicate race regression', () => {
	it('treats a file-hash conflict after upload as duplicate and skips observability writes', async () => {
		const [{ executeIngest }, { createLogger }] = await Promise.all([
			import(pathToFileURL(PIPELINE_MODULE).href),
			import(pathToFileURL(CORE_MODULE).href),
		]);

		const existingSourceId = randomUUID();
		let canonicalBlobPath = '';
		const now = new Date();
		const queries: string[] = [];
		const uploads: string[] = [];
		const deletes: string[] = [];
		const firestoreWrites: string[] = [];

		const pool = {
			query: async (sql: string, values: unknown[] = []) => {
				queries.push(sql);
				if (sql.includes('SELECT * FROM sources WHERE file_hash')) {
					return { rows: [], rowCount: 0 };
				}
				if (sql.includes('SELECT * FROM document_blobs WHERE content_hash')) {
					return { rows: [], rowCount: 0 };
				}
				if (sql.includes('INSERT INTO document_blobs')) {
					canonicalBlobPath = String(values[1]);
					return {
						rows: [
							{
								content_hash: String(values[0]),
								mulder_blob_id: randomUUID(),
								storage_path: canonicalBlobPath,
								storage_uri: String(values[2]),
								mime_type: String(values[3]),
								file_size_bytes: String(values[4]),
								storage_class: 'standard',
								storage_status: 'active',
								original_filenames: ['native-text-sample.pdf'],
								first_ingested_at: now,
								last_accessed_at: now,
								integrity_verified_at: null,
								integrity_status: 'unverified',
								created_at: now,
								updated_at: now,
							},
						],
						rowCount: 1,
					};
				}
				if (sql.includes('INSERT INTO sources')) {
					return {
						rows: [
							{
								id: existingSourceId,
								filename: 'native-text-sample.pdf',
								storage_path: canonicalBlobPath,
								file_hash: String(values[3]),
								parent_source_id: null,
								source_type: 'pdf',
								format_metadata: {},
								page_count: 1,
								has_native_text: true,
								native_text_ratio: 1,
								status: 'ingested',
								reliability_score: null,
								tags: [],
								metadata: {},
								created_at: now,
								updated_at: now,
							},
						],
						rowCount: 1,
					};
				}
				throw new Error(`Unexpected query after duplicate race: ${sql}`);
			},
		};

		const services = {
			storage: {
				upload: async (path: string) => {
					uploads.push(path);
				},
				buildUri: (path: string) => `gs://test-bucket/${path}`,
				exists: async () => false,
				delete: async (path: string) => {
					deletes.push(path);
				},
			},
			firestore: {
				setDocument: async (_collection: string, documentId: string) => {
					firestoreWrites.push(documentId);
				},
			},
		};

		const result = await executeIngest(
			{ path: NATIVE_TEXT_PDF },
			{ ingestion: { max_file_size_mb: 100, max_pages: 2000 } },
			services,
			pool,
			createLogger({ level: 'silent' }),
		);

		expect(result.errors).toEqual([]);
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({
			sourceId: existingSourceId,
			storagePath: canonicalBlobPath,
			duplicate: true,
		});
		expect(result.metadata.items_skipped).toBe(1);
		expect(uploads).toHaveLength(1);
		expect(deletes).toEqual([]);
		expect(firestoreWrites).toEqual([]);
		expect(queries.some((sql) => sql.includes('source_steps'))).toBe(false);
	});
});
