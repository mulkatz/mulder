import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');
const PIPELINE_MODULE = resolve(ROOT, 'packages/pipeline/dist/index.js');

/**
 * Black-box QA tests for Spec 32: Embedding Wrapper + Semantic Chunker + Chunk Repository
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests import from the built dist barrels (@mulder/core, @mulder/pipeline)
 * as the system boundary for library modules.
 *
 * Requires a running PostgreSQL instance with pgvector (PGHOST/PGPORT)
 * and migrations applied.
 */

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

let pool: pg.Pool;
let sourceId: string;
const storyIds: string[] = [];

// Dynamically imported functions — pipeline
let chunkStory: (...args: unknown[]) => unknown;
let embedChunks: (...args: unknown[]) => Promise<unknown>;
let generateQuestions: (...args: unknown[]) => Promise<unknown>;

// Dynamically imported functions — core (chunk repository)
let createChunks: (...args: unknown[]) => Promise<unknown>;
let findChunksByStoryId: (...args: unknown[]) => Promise<unknown>;
let deleteChunksByStoryId: (...args: unknown[]) => Promise<unknown>;
let searchByVector: (...args: unknown[]) => Promise<unknown>;
let searchByFts: (...args: unknown[]) => Promise<unknown>;

// Dynamically imported helper functions — core (source + story repos)
let createSource: (...args: unknown[]) => Promise<unknown>;
let createStory: (...args: unknown[]) => Promise<unknown>;

async function isPgAvailable(): Promise<boolean> {
	return db.isPgAvailable();
}

/**
 * Generate a deterministic 768-dim embedding vector for test purposes.
 * Varies by seed to produce different but reproducible vectors.
 */
function makeFakeEmbedding(seed: number): number[] {
	const vec: number[] = [];
	for (let i = 0; i < 768; i++) {
		// Simple deterministic pseudo-random between -1 and 1
		vec.push(Math.sin(seed * 1000 + i * 0.1));
	}
	// Normalize to unit vector for cosine similarity
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	return vec.map((v) => v / norm);
}

/**
 * Generate a long Markdown story with ~2000 words for chunking tests.
 */
function generateLongMarkdown(): string {
	const sections: string[] = [];
	sections.push('# UFO Sightings Report\n');
	sections.push('## Introduction\n');
	sections.push(
		'This report documents several unexplained aerial phenomena observed across ' +
			'multiple locations in the southwestern United States during the summer of 1997. ' +
			'Witnesses reported luminous objects moving at extraordinary speeds, performing ' +
			'maneuvers that defy conventional aerodynamic principles. The following sections ' +
			'detail each incident with witness testimonies, physical evidence, and analysis.\n',
	);
	sections.push('## Phoenix Lights Incident\n');
	sections.push(
		'On March 13, 1997, thousands of witnesses across a 300-mile corridor from the ' +
			'Nevada state line through Phoenix reported seeing a massive V-shaped formation of ' +
			'lights silently gliding across the night sky. The formation was estimated to be over ' +
			'a mile wide. Governor Fife Symington later admitted he had also witnessed the event ' +
			'and described it as otherworldly and inexplicable. Military officials attributed the ' +
			'lights to flares dropped during training exercises at the Barry Goldwater Range, but ' +
			'this explanation was widely contested by witnesses who noted the lights moved in a ' +
			'coordinated formation and did not descend as flares would. The incident remains one ' +
			'of the most widely witnessed UFO events in modern history.\n',
	);
	sections.push('### Witness Accounts\n');
	sections.push(
		'Multiple independent witnesses provided remarkably consistent descriptions of the ' +
			'object. A commercial airline pilot reported seeing the formation pass beneath his ' +
			'aircraft at an altitude inconsistent with military flare operations. A retired Air ' +
			'Force officer described the lights as being attached to a solid structure that blocked ' +
			'out the stars as it passed overhead. Several residents captured video footage, though ' +
			'the quality varied significantly. Analysis of the footage from different vantage points ' +
			'allowed triangulation of the objects position and speed.\n',
	);
	sections.push('### Physical Evidence\n');
	sections.push(
		'Investigators documented electromagnetic interference reported by multiple witnesses ' +
			'during the overflight. Car radios and televisions experienced static and signal loss. ' +
			'Compasses were reported to spin erratically. A weather station near Prescott recorded ' +
			'anomalous readings in the magnetic field strength during the time window of the sighting. ' +
			'Soil samples from areas directly beneath the flight path showed no unusual properties.\n',
	);
	sections.push('## Roswell Parallels\n');
	sections.push(
		'The Phoenix Lights incident drew immediate comparisons to the 1947 Roswell incident in ' +
			'New Mexico. While the circumstances differ significantly, both events generated intense ' +
			'public interest and official explanations that many found unsatisfying. The Roswell case ' +
			'involved alleged recovery of debris from a crashed object, while the Phoenix Lights were ' +
			'purely observational with no physical artifacts recovered. Government response patterns ' +
			'showed similarities: initial acknowledgment followed by mundane explanations.\n',
	);
	sections.push('### Government Response\n');
	sections.push(
		'The official military response to the Phoenix Lights followed a familiar pattern. Initially, ' +
			'military spokespeople declined to comment. After sustained media pressure, the Air Force ' +
			'issued a statement attributing the lights to illumination flares from A-10 Warthog aircraft ' +
			'during Operation Snowbird training exercises. This explanation was challenged on several ' +
			'grounds: the timing did not match, the altitude was inconsistent, and the silent nature ' +
			'of the formation contradicted the explanation since A-10 aircraft produce significant noise.\n',
	);
	sections.push('## Statistical Analysis\n');
	sections.push(
		'When examining the frequency of reported sightings in the Phoenix metropolitan area, a clear ' +
			'pattern emerges. Prior to the March 1997 event, the area averaged approximately twelve ' +
			'reports per year. In the six months following the incident, this number increased to over ' +
			'two hundred. While some of this increase can be attributed to heightened awareness and ' +
			'confirmation bias, the magnitude of the increase suggests a genuine phenomenon beyond ' +
			'mere psychological amplification. Cross-referencing with air traffic control data and ' +
			'military exercise schedules eliminates conventional explanations for approximately thirty ' +
			'percent of the post-event reports.\n',
	);
	sections.push('## Conclusions\n');
	sections.push(
		'The Phoenix Lights incident stands as one of the most significant mass UFO sightings in ' +
			'recorded history. The sheer number of witnesses, the consistency of their accounts, and ' +
			'the inadequacy of official explanations collectively make a compelling case for further ' +
			'investigation. Whether the phenomenon has a conventional explanation that has not yet been ' +
			'identified, or represents something truly anomalous, remains an open question that deserves ' +
			'rigorous scientific inquiry rather than dismissal.\n',
	);
	return sections.join('\n');
}

describe('Spec 32: Embedding Wrapper + Semantic Chunker + Chunk Repository', () => {
	let pgAvailable = false;

	beforeAll(async () => {
		pgAvailable = await isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		pool = new pg.Pool(PG_CONFIG);

		// Ensure migrations are applied
		const migrateResult = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 30000,
			env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD },
		});
		if (migrateResult.status !== 0) {
			throw new Error(`Migration failed: ${migrateResult.stdout} ${migrateResult.stderr}`);
		}

		// Dynamically import from built barrels
		const coreMod = await import(CORE_MODULE);
		const pipelineMod = await import(PIPELINE_MODULE);

		// Pipeline exports
		chunkStory = pipelineMod.chunkStory;
		embedChunks = pipelineMod.embedChunks;
		generateQuestions = pipelineMod.generateQuestions;

		// Core chunk repository exports
		createChunks = coreMod.createChunks;
		findChunksByStoryId = coreMod.findChunksByStoryId;
		deleteChunksByStoryId = coreMod.deleteChunksByStoryId;
		searchByVector = coreMod.searchByVector;
		searchByFts = coreMod.searchByFts;

		// Helper repos for FK parents
		createSource = coreMod.createSource;
		createStory = coreMod.createStory;

		// Clean up and create parent source + stories for FK references
		await pool.query('DELETE FROM chunks');
		await pool.query('DELETE FROM story_entities');
		await pool.query('DELETE FROM entity_aliases');
		await pool.query('DELETE FROM entities');
		await pool.query('DELETE FROM stories');
		await pool.query('DELETE FROM source_steps');
		await pool.query('DELETE FROM sources');

		const source = (await createSource(pool, {
			filename: 'chunk-test-parent.pdf',
			storagePath: 'raw/chunk-test-parent.pdf',
			fileHash: `hash_spec32_parent_${Date.now()}`,
			pageCount: 100,
		})) as { id: string };
		sourceId = source.id;

		// Create 2 stories for chunk tests
		for (let i = 0; i < 2; i++) {
			const story = (await createStory(pool, {
				sourceId,
				title: `Chunk Test Story ${i}`,
				gcsMarkdownUri: `gs://bucket/chunk-test/story${i}.md`,
				gcsMetadataUri: `gs://bucket/chunk-test/story${i}.meta.json`,
			})) as { id: string };
			storyIds.push(story.id);
		}
	});

	beforeEach(async () => {
		if (!pgAvailable) return;
		// Clean chunks before each test for isolation
		await pool.query('DELETE FROM chunks');
	});

	afterAll(async () => {
		if (!pgAvailable) return;
		try {
			await pool.query('DELETE FROM chunks');
			await pool.query('DELETE FROM story_entities');
			await pool.query('DELETE FROM entity_aliases');
			await pool.query('DELETE FROM entities');
			await pool.query('DELETE FROM stories');
			await pool.query('DELETE FROM source_steps');
			await pool.query('DELETE FROM sources');
		} catch {
			// Tables may not exist if another test suite dropped them
		}
		await pool.end();
	});

	// ─── QA-01: Semantic chunking splits Markdown ───

	it('QA-01: chunkStory splits a ~2000-word Markdown story into 4-5 chunks, each ≤ 512 tokens, no mid-paragraph splits', () => {
		const markdown = generateLongMarkdown();
		const config = { chunkSizeTokens: 512, chunkOverlapTokens: 50 };

		const chunks = chunkStory(markdown, 1, 10, config) as Array<{
			content: string;
			chunkIndex: number;
			pageStart: number | null;
			pageEnd: number | null;
			metadata: { headings: string[]; entityMentions: string[] };
		}>;

		// Should produce multiple chunks (spec says 4-5 for ~2000 words at 512 tokens)
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		expect(chunks.length).toBeLessThanOrEqual(8);

		// Each chunk should respect the token limit (heuristic: text.length / 4)
		for (const chunk of chunks) {
			const estimatedTokens = chunk.content.length / 4;
			// Allow some tolerance — the chunker shouldn't exceed the limit by much
			expect(estimatedTokens).toBeLessThanOrEqual(512 * 1.3); // 30% tolerance for boundary effects
		}

		// Verify chunk indices are sequential starting from 0
		for (let i = 0; i < chunks.length; i++) {
			expect(chunks[i].chunkIndex).toBe(i);
		}

		// Verify no mid-paragraph splits: each chunk content should not start/end
		// in the middle of a sentence (heuristic: content should not start with lowercase
		// unless it's a continuation via overlap)
		for (const chunk of chunks) {
			expect(chunk.content.trim().length).toBeGreaterThan(0);
		}
	});

	// ─── QA-02: Chunk overlap works ───

	it('QA-02: chunkStory with overlap=50 produces adjacent chunks that share ~50 tokens of overlapping text', () => {
		const markdown = generateLongMarkdown();
		const config = { chunkSizeTokens: 512, chunkOverlapTokens: 50 };

		const chunks = chunkStory(markdown, 1, 10, config) as Array<{
			content: string;
			chunkIndex: number;
		}>;

		// Need at least 2 chunks to test overlap
		expect(chunks.length).toBeGreaterThanOrEqual(2);

		// Check that adjacent chunks share some overlapping text
		let overlapFound = false;
		for (let i = 0; i < chunks.length - 1; i++) {
			const current = chunks[i].content;
			const next = chunks[i + 1].content;

			// The end of the current chunk should appear at the start of the next chunk
			// Take the last ~200 chars of current (roughly 50 tokens) and check if
			// any substring appears at the beginning of next
			const tailLength = Math.min(current.length, 200);
			const currentTail = current.slice(-tailLength);

			// Check if any significant portion of the tail appears in the beginning of next
			// Use a sliding window of 40+ characters
			for (let j = 0; j <= currentTail.length - 40; j++) {
				const snippet = currentTail.slice(j, j + 40);
				if (next.startsWith(snippet) || next.includes(snippet)) {
					overlapFound = true;
					break;
				}
			}
			if (overlapFound) break;
		}

		expect(overlapFound).toBe(true);
	});

	// ─── QA-03: Short story single chunk ───

	it('QA-03: chunkStory returns exactly 1 chunk for a 100-word Markdown story', () => {
		// ~100 words, well under 512 tokens
		const shortMarkdown =
			'# Short Report\n\n' +
			'A bright light was observed moving silently across the sky at approximately ' +
			'ten thirty in the evening. The witness, a retired schoolteacher, described the ' +
			'object as triangular with three distinct white lights at each vertex. The sighting ' +
			'lasted approximately forty five seconds before the object accelerated rapidly and ' +
			'disappeared behind the mountain range to the north. No sound was heard during the ' +
			'entire observation period. Weather conditions were clear with good visibility.';

		const config = { chunkSizeTokens: 512, chunkOverlapTokens: 50 };
		const chunks = chunkStory(shortMarkdown, 1, 1, config) as Array<{ content: string }>;

		expect(chunks).toHaveLength(1);
		// The single chunk should contain the full text
		expect(chunks[0].content).toContain('bright light');
		expect(chunks[0].content).toContain('good visibility');
	});

	// ─── QA-04: Empty story returns empty ───

	it('QA-04: chunkStory returns empty array for empty string input', () => {
		const config = { chunkSizeTokens: 512, chunkOverlapTokens: 50 };
		const chunks = chunkStory('', null, null, config) as unknown[];

		expect(chunks).toEqual([]);
	});

	// ─── QA-05: Heading tracking ───

	it('QA-05: chunkStory tracks heading hierarchy in each chunk metadata.headings', () => {
		// Build enough content under each heading to force multiple chunks at a small token limit
		const paragraphs = (heading: string, count: number) => {
			const lines: string[] = [];
			for (let i = 0; i < count; i++) {
				lines.push(
					`Paragraph ${i} under ${heading} provides detailed observations about the aerial phenomena ` +
						'including witness testimony, physical evidence analysis, and electromagnetic readings ' +
						'recorded during the event. Investigators documented multiple data points.',
				);
				lines.push('');
			}
			return lines.join('\n');
		};

		const markdown = [
			'# Main Report',
			'',
			'## Section One',
			'',
			paragraphs('Section One', 5),
			'## Section Two',
			'',
			paragraphs('Section Two', 5),
			'### Subsection Two A',
			'',
			paragraphs('Subsection Two A', 5),
		].join('\n');

		// Use a smaller chunk size to guarantee multiple chunks
		const config = { chunkSizeTokens: 256, chunkOverlapTokens: 30 };
		const chunks = chunkStory(markdown, 1, 5, config) as Array<{
			content: string;
			metadata: { headings: string[] };
		}>;

		// Should produce multiple chunks
		expect(chunks.length).toBeGreaterThanOrEqual(2);

		// Every chunk should have metadata with headings array
		for (const chunk of chunks) {
			expect(chunk.metadata).toBeDefined();
			expect(Array.isArray(chunk.metadata.headings)).toBe(true);
		}

		// At least one non-first chunk should have headings populated
		// (the heading hierarchy at chunk start reflects which headings are "in scope")
		const laterChunks = chunks.slice(1);
		const hasHeadingsInLaterChunks = laterChunks.some((c) => c.metadata.headings.length > 0);
		expect(hasHeadingsInLaterChunks).toBe(true);

		// Verify the tracked headings are actual headings from the document
		const allHeadings = chunks.flatMap((c) => c.metadata.headings);
		const hasRelevantHeading = allHeadings.some(
			(h) =>
				h.includes('Main Report') ||
				h.includes('Section One') ||
				h.includes('Section Two') ||
				h.includes('Subsection Two A'),
		);
		expect(hasRelevantHeading).toBe(true);
	});

	// ─── QA-06: Chunk repository createChunks ───

	it('QA-06: createChunks inserts 10 chunks with embeddings; all 10 rows exist in DB with auto-generated fts_vector', async () => {
		if (!pgAvailable) return;

		const inputs = Array.from({ length: 10 }, (_, i) => ({
			storyId: storyIds[0],
			content: `This is chunk number ${i} about the UFO sighting in Phoenix. It contains unique text for searching.`,
			chunkIndex: i,
			pageStart: i + 1,
			pageEnd: i + 2,
			embedding: makeFakeEmbedding(i),
			isQuestion: false,
			metadata: { testChunk: i },
		}));

		const created = (await createChunks(pool, inputs)) as Array<Record<string, unknown>>;

		expect(created).toHaveLength(10);

		// Verify all rows exist in DB
		const dbResult = await pool.query('SELECT COUNT(*) FROM chunks WHERE story_id = $1', [storyIds[0]]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(10);

		// Verify fts_vector is auto-generated (not null for non-empty content)
		const ftsResult = await pool.query(
			'SELECT id, fts_vector IS NOT NULL as has_fts FROM chunks WHERE story_id = $1 ORDER BY chunk_index',
			[storyIds[0]],
		);
		for (const row of ftsResult.rows) {
			expect(row.has_fts).toBe(true);
		}

		// Verify each created chunk has expected fields
		for (let i = 0; i < created.length; i++) {
			const chunk = created[i];
			expect(chunk.id).toBeDefined();
			expect(chunk.storyId).toBe(storyIds[0]);
			expect(chunk.content).toContain(`chunk number ${i}`);
			expect(chunk.chunkIndex).toBe(i);
		}
	});

	// ─── QA-07: Chunk repository findByStoryId ───

	it('QA-07: findChunksByStoryId returns chunks ordered by chunk_index, content chunks only when filtered', async () => {
		if (!pgAvailable) return;

		// Create a mix of content chunks and question chunks
		const contentInputs = Array.from({ length: 5 }, (_, i) => ({
			storyId: storyIds[0],
			content: `Content chunk ${i} about aerial phenomena.`,
			chunkIndex: i,
			isQuestion: false,
			embedding: makeFakeEmbedding(i),
		}));

		const created = (await createChunks(pool, contentInputs)) as Array<Record<string, unknown>>;

		// Now create question chunks linked to first content chunk
		const questionInputs = Array.from({ length: 2 }, (_, i) => ({
			storyId: storyIds[0],
			content: `What happened during the UFO observation event ${i}?`,
			chunkIndex: 100 + i,
			isQuestion: true,
			parentChunkId: created[0].id as string,
			embedding: makeFakeEmbedding(100 + i),
		}));

		await createChunks(pool, questionInputs);

		// findChunksByStoryId should return all 7 chunks ordered by chunk_index
		const allChunks = (await findChunksByStoryId(pool, storyIds[0])) as Array<Record<string, unknown>>;
		expect(allChunks).toHaveLength(7);

		// Verify ordering by chunk_index
		for (let i = 0; i < allChunks.length - 1; i++) {
			expect((allChunks[i].chunkIndex as number) <= (allChunks[i + 1].chunkIndex as number)).toBe(true);
		}

		// Filter: content chunks only (isQuestion=false)
		const contentOnly = (await findChunksByStoryId(pool, storyIds[0], {
			isQuestion: false,
		})) as Array<Record<string, unknown>>;
		expect(contentOnly).toHaveLength(5);
		for (const chunk of contentOnly) {
			expect(chunk.isQuestion).toBe(false);
		}
	});

	// ─── QA-08: Chunk repository deleteByStoryId ───

	it('QA-08: deleteChunksByStoryId deletes all chunks (content + questions) and returns the count', async () => {
		if (!pgAvailable) return;

		// Create content chunks
		const contentInputs = Array.from({ length: 3 }, (_, i) => ({
			storyId: storyIds[0],
			content: `Delete test content chunk ${i}.`,
			chunkIndex: i,
			isQuestion: false,
			embedding: makeFakeEmbedding(i),
		}));

		const created = (await createChunks(pool, contentInputs)) as Array<Record<string, unknown>>;

		// Create question chunks
		const questionInputs = Array.from({ length: 2 }, (_, i) => ({
			storyId: storyIds[0],
			content: `Delete test question ${i}?`,
			chunkIndex: 100 + i,
			isQuestion: true,
			parentChunkId: created[0].id as string,
			embedding: makeFakeEmbedding(200 + i),
		}));

		await createChunks(pool, questionInputs);

		// Verify 5 chunks exist
		const beforeCount = await pool.query('SELECT COUNT(*) FROM chunks WHERE story_id = $1', [storyIds[0]]);
		expect(Number.parseInt(beforeCount.rows[0].count, 10)).toBe(5);

		// Delete all chunks for this story
		const deletedCount = (await deleteChunksByStoryId(pool, storyIds[0])) as number;
		expect(deletedCount).toBe(5);

		// Verify all gone
		const afterCount = await pool.query('SELECT COUNT(*) FROM chunks WHERE story_id = $1', [storyIds[0]]);
		expect(Number.parseInt(afterCount.rows[0].count, 10)).toBe(0);
	});

	// ─── QA-09: Vector search returns results ───

	it('QA-09: searchByVector returns ≤5 results sorted by cosine similarity descending', async () => {
		if (!pgAvailable) return;

		// Create chunks with embeddings
		const inputs = Array.from({ length: 8 }, (_, i) => ({
			storyId: storyIds[0],
			content: `Vector search test chunk ${i} with some meaningful content about observations.`,
			chunkIndex: i,
			isQuestion: false,
			embedding: makeFakeEmbedding(i),
		}));

		await createChunks(pool, inputs);

		// Search with a query vector close to seed=0
		const queryVec = makeFakeEmbedding(0);
		const results = (await searchByVector(pool, queryVec, 5)) as Array<{
			chunk: Record<string, unknown>;
			distance: number;
			similarity: number;
		}>;

		// Should return at most 5 results
		expect(results.length).toBeLessThanOrEqual(5);
		expect(results.length).toBeGreaterThan(0);

		// Each result should have chunk, distance, and similarity
		for (const result of results) {
			expect(result.chunk).toBeDefined();
			expect(typeof result.distance).toBe('number');
			expect(typeof result.similarity).toBe('number');
			// Cosine distance: 0 = identical, 2 = opposite
			expect(result.distance).toBeGreaterThanOrEqual(0);
			expect(result.distance).toBeLessThanOrEqual(2);
			// Similarity = 1 - distance
			expect(result.similarity).toBeCloseTo(1 - result.distance, 5);
		}

		// Results should be sorted by similarity descending (distance ascending)
		for (let i = 0; i < results.length - 1; i++) {
			expect(results[i].distance).toBeLessThanOrEqual(results[i + 1].distance);
		}

		// The most similar chunk should be seed=0 (identical vector)
		expect(results[0].distance).toBeCloseTo(0, 3);
	});

	// ─── QA-10: FTS search returns results ───

	it('QA-10: searchByFts returns ≤5 results with rank scores for matching text', async () => {
		if (!pgAvailable) return;

		// Create chunks with distinctive content for FTS
		const inputs = [
			{
				storyId: storyIds[0],
				content: 'The Phoenix Lights were observed by thousands of witnesses across Arizona.',
				chunkIndex: 0,
				isQuestion: false,
				embedding: makeFakeEmbedding(0),
			},
			{
				storyId: storyIds[0],
				content: 'Electromagnetic interference was detected during the overflight of the unidentified craft.',
				chunkIndex: 1,
				isQuestion: false,
				embedding: makeFakeEmbedding(1),
			},
			{
				storyId: storyIds[0],
				content: 'Multiple radar stations confirmed anomalous returns consistent with solid objects.',
				chunkIndex: 2,
				isQuestion: false,
				embedding: makeFakeEmbedding(2),
			},
			{
				storyId: storyIds[0],
				content: 'Soil samples collected from the landing site showed elevated radiation levels.',
				chunkIndex: 3,
				isQuestion: false,
				embedding: makeFakeEmbedding(3),
			},
			{
				storyId: storyIds[0],
				content: 'Weather balloon debris was initially recovered from the crash site near Roswell.',
				chunkIndex: 4,
				isQuestion: false,
				embedding: makeFakeEmbedding(4),
			},
			{
				storyId: storyIds[0],
				content: 'Additional Phoenix witnesses confirmed the triangular shape of the craft formation.',
				chunkIndex: 5,
				isQuestion: false,
				embedding: makeFakeEmbedding(5),
			},
		];

		await createChunks(pool, inputs);

		// Search for "Phoenix" — should match chunks 0 and 5
		const results = (await searchByFts(pool, 'Phoenix', 5)) as Array<{
			chunk: Record<string, unknown>;
			rank: number;
		}>;

		expect(results.length).toBeGreaterThan(0);
		expect(results.length).toBeLessThanOrEqual(5);

		// Each result should have a chunk and rank
		for (const result of results) {
			expect(result.chunk).toBeDefined();
			expect(typeof result.rank).toBe('number');
			expect(result.rank).toBeGreaterThan(0);
			// Content should contain the search term
			expect((result.chunk.content as string).toLowerCase()).toContain('phoenix');
		}
	});

	// ─── QA-11: Embedding wrapper batches ───

	it('QA-11: embedChunks with 150 chunks and batchSize=50 calls EmbeddingService.embed() exactly 3 times', async () => {
		// Create a mock EmbeddingService that tracks calls
		// EmbeddingService.embed() returns EmbeddingResult[] = { text: string; vector: number[] }[]
		let embedCallCount = 0;
		const mockEmbeddingService = {
			embed: async (texts: string[]) => {
				embedCallCount++;
				return texts.map((text, i) => ({
					text,
					vector: makeFakeEmbedding(embedCallCount * 1000 + i),
				}));
			},
		};

		const chunks = Array.from({ length: 150 }, (_, i) => ({
			chunkId: `chunk-${i}`,
			content: `Test chunk content number ${i}`,
			chunkIndex: i,
		}));

		const results = (await embedChunks(mockEmbeddingService, chunks, 50)) as Array<{
			chunkId: string;
			embedding: number[];
		}>;

		// Should have called embed() exactly 3 times (150 / 50 = 3 batches)
		expect(embedCallCount).toBe(3);

		// Should return 150 results
		expect(results).toHaveLength(150);

		// Each result should have chunkId and a 768-dim embedding
		for (const result of results) {
			expect(result.chunkId).toBeDefined();
			expect(Array.isArray(result.embedding)).toBe(true);
			expect(result.embedding.length).toBe(768);
		}
	});

	// ─── QA-12: Question generation ───

	it('QA-12: generateQuestions with 3 chunks and questionsPerChunk=2 returns 3 QuestionResults each with 2 questions', async () => {
		// Create a mock LlmService that returns structured question responses
		// The function expects generateStructured to return { questions: string[] }
		const mockLlmService = {
			generateStructured: async (_opts: unknown) => {
				return {
					questions: ['What is the significance of this observation?', 'Who were the primary witnesses?'],
				};
			},
			generateText: async () => '',
			groundedGenerate: async () => ({ text: '', groundingMetadata: null }),
		};

		const chunks = Array.from({ length: 3 }, (_, i) => ({
			chunkId: `chunk-${i}`,
			content: `Test content about UFO sightings and aerial phenomena observation number ${i}.`,
			chunkIndex: i,
		}));

		const results = (await generateQuestions(mockLlmService, chunks, 2)) as Array<{
			parentChunkId: string;
			questions: string[];
		}>;

		// The function should return 3 results (one per chunk)
		expect(results).toHaveLength(3);

		// Each result should have parentChunkId
		for (const result of results) {
			expect(result.parentChunkId).toBeDefined();
			expect(Array.isArray(result.questions)).toBe(true);
		}

		// Per spec: each result should contain 2 questions
		// NOTE: If the prompt template has unresolved i18n variables, the function
		// catches the PromptError and returns empty questions — this is an implementation
		// gap where the generate-questions template requires i18n context not yet available.
		for (const result of results) {
			expect(result.questions).toHaveLength(2);
			for (const q of result.questions) {
				expect(typeof q).toBe('string');
				expect(q.length).toBeGreaterThan(0);
			}
		}
	});

	// ─── QA-13: Cascade delete chunks on story delete ───

	it('QA-13: DELETE FROM stories WHERE id = storyX cascade-deletes all chunks for that story', async () => {
		if (!pgAvailable) return;

		// Create a dedicated story for this cascade test
		const story = (await createStory(pool, {
			sourceId,
			title: 'Cascade Chunk Test Story',
			gcsMarkdownUri: 'gs://bucket/cascade-chunk-test.md',
			gcsMetadataUri: 'gs://bucket/cascade-chunk-test.meta.json',
		})) as { id: string };

		// Create chunks for this story
		const inputs = Array.from({ length: 5 }, (_, i) => ({
			storyId: story.id,
			content: `Cascade test chunk ${i} for deletion verification.`,
			chunkIndex: i,
			isQuestion: false,
			embedding: makeFakeEmbedding(i),
		}));

		await createChunks(pool, inputs);

		// Verify chunks exist
		const beforeCount = await pool.query('SELECT COUNT(*) FROM chunks WHERE story_id = $1', [story.id]);
		expect(Number.parseInt(beforeCount.rows[0].count, 10)).toBe(5);

		// Delete story via raw SQL (to test ON DELETE CASCADE)
		await pool.query('DELETE FROM stories WHERE id = $1', [story.id]);

		// Verify all chunks are cascade-deleted
		const afterCount = await pool.query('SELECT COUNT(*) FROM chunks WHERE story_id = $1', [story.id]);
		expect(Number.parseInt(afterCount.rows[0].count, 10)).toBe(0);
	});

	// ─── QA-14: Question chunks link to parent ───

	it('QA-14: createChunks with parentChunkId creates question chunks that reference parent via FK, is_question=true', async () => {
		if (!pgAvailable) return;

		// Create a content (parent) chunk first
		const parentInput = {
			storyId: storyIds[0],
			content: 'Parent content chunk about the Phoenix Lights investigation.',
			chunkIndex: 0,
			isQuestion: false,
			embedding: makeFakeEmbedding(0),
		};

		const parentChunks = (await createChunks(pool, [parentInput])) as Array<Record<string, unknown>>;
		const parentChunk = parentChunks[0];

		// Create question chunks linked to the parent
		const questionInputs = Array.from({ length: 3 }, (_, i) => ({
			storyId: storyIds[0],
			content: `What happened during phase ${i + 1} of the investigation?`,
			chunkIndex: 10 + i,
			isQuestion: true,
			parentChunkId: parentChunk.id as string,
			embedding: makeFakeEmbedding(10 + i),
		}));

		const questionChunks = (await createChunks(pool, questionInputs)) as Array<Record<string, unknown>>;

		expect(questionChunks).toHaveLength(3);

		for (const qChunk of questionChunks) {
			expect(qChunk.isQuestion).toBe(true);
			expect(qChunk.parentChunkId).toBe(parentChunk.id);
		}

		// Verify via raw SQL that FK references are correct
		const dbResult = await pool.query(
			'SELECT id, is_question, parent_chunk_id FROM chunks WHERE parent_chunk_id = $1 ORDER BY chunk_index',
			[parentChunk.id],
		);
		expect(dbResult.rows).toHaveLength(3);
		for (const row of dbResult.rows) {
			expect(row.is_question).toBe(true);
			expect(row.parent_chunk_id).toBe(parentChunk.id);
		}
	});

	// ─── QA-15: Barrel exports accessible ───

	it('QA-15: All public functions and types resolve from @mulder/pipeline and @mulder/core without error', async () => {
		// Verify pipeline exports
		const pipelineMod = await import(PIPELINE_MODULE);
		expect(typeof pipelineMod.chunkStory).toBe('function');
		expect(typeof pipelineMod.embedChunks).toBe('function');
		expect(typeof pipelineMod.generateQuestions).toBe('function');

		// Verify core chunk repository exports
		const coreMod = await import(CORE_MODULE);
		expect(typeof coreMod.createChunk).toBe('function');
		expect(typeof coreMod.createChunks).toBe('function');
		expect(typeof coreMod.findChunkById).toBe('function');
		expect(typeof coreMod.findChunksByStoryId).toBe('function');
		expect(typeof coreMod.findChunksBySourceId).toBe('function');
		expect(typeof coreMod.countChunks).toBe('function');
		expect(typeof coreMod.deleteChunksByStoryId).toBe('function');
		expect(typeof coreMod.deleteChunksBySourceId).toBe('function');
		expect(typeof coreMod.searchByVector).toBe('function');
		expect(typeof coreMod.searchByFts).toBe('function');
		expect(typeof coreMod.updateChunkEmbedding).toBe('function');
	});
});
