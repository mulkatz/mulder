import { spawnSync } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = resolve(SCRIPT_DIR, '../..');
const ROOT = resolve(DEMO_DIR, '..');
const CONFIG_PATH = resolve(DEMO_DIR, 'tests/config/mulder.e2e.config.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');
const STORAGE_DIR = resolve(ROOT, '.local/storage');
const SESSION_SECRET = 'mulder-e2e-session-secret';
const OWNER_EMAIL = 'owner.e2e@mulder.local';
const OWNER_PASSWORD = 'correct horse battery staple';
const INVITE_EMAIL = 'invite.e2e@mulder.local';
const INVITE_TOKEN = 'mulder-e2e-invite-token';
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const STORY_IDS = [
	'22222222-2222-4222-8222-222222222221',
	'22222222-2222-4222-8222-222222222222',
	'22222222-2222-4222-8222-222222222223',
];
const ENTITY_IDS = {
	hynek: '33333333-3333-4333-8333-333333333331',
	area51: '33333333-3333-4333-8333-333333333332',
	arnold: '33333333-3333-4333-8333-333333333333',
	blueBook: '33333333-3333-4333-8333-333333333334',
};
const EDGE_IDS = [
	'44444444-4444-4444-8444-444444444441',
	'44444444-4444-4444-8444-444444444442',
];
const PAGE_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8efMmAwAIAgK1Z9hQJwAAAABJRU5ErkJggg==';

const packagesToBuild = [
	'@mulder/core',
	'@mulder/taxonomy',
	'@mulder/retrieval',
	'@mulder/pipeline',
	'@mulder/worker',
	'@mulder/evidence',
	'@mulder/api',
];

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: ROOT,
		stdio: 'inherit',
		env: {
			...process.env,
			MULDER_LOG_LEVEL: 'silent',
		},
		...options,
	});

	if ((result.status ?? 1) !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(' ')}`);
	}
}

function buildPackages() {
	for (const packageName of packagesToBuild) {
		run('pnpm', ['--filter', packageName, 'build']);
	}
}

function hashPassword(password) {
	const salt = Buffer.from('mulder-demo-e2e-password-salt').toString('base64url');
	const derived = scryptSync(password, salt, 64);
	return `scrypt:${salt}:${derived.toString('base64url')}`;
}

function hashToken(token) {
	return createHash('sha256').update(`${SESSION_SECRET}:${token}`).digest('hex');
}

function writeStorageArtifacts() {
	const rawDir = resolve(STORAGE_DIR, `raw/${SOURCE_ID}`);
	const extractedDir = resolve(STORAGE_DIR, `extracted/${SOURCE_ID}`);
	const pagesDir = resolve(extractedDir, 'pages');

	mkdirSync(rawDir, { recursive: true });
	mkdirSync(pagesDir, { recursive: true });
	copyFileSync(resolve(ROOT, 'fixtures/raw/native-text-sample.pdf'), resolve(rawDir, 'original.pdf'));

	writeFileSync(
		resolve(extractedDir, 'layout.md'),
		[
			'# Project Blue Book notes',
			'',
			'Josef Allen Hynek reviewed reports from Area 51 with Project Blue Book investigators.',
			'The notes describe a careful attempt to separate witness claims from archival records.',
			'',
			'# Hynek interview transcript',
			'',
			'J. Allen Hynek compared Kenneth Arnold sightings with Area 51 rumors in a later interview.',
			'Hynek emphasized that repeated names matter only when tied back to documents.',
			'',
			'# Archive follow-up',
			'',
			'Project Blue Book staff returned to Area 51 references after Kenneth Arnold appeared in the index.',
			'The follow-up created a clean chain from person to location to source.',
			'',
		].join('\n'),
	);

	const pagePng = Buffer.from(PAGE_PNG_BASE64, 'base64');
	for (let page = 1; page <= 3; page += 1) {
		writeFileSync(resolve(pagesDir, `page-${String(page).padStart(3, '0')}.png`), pagePng);
	}
}

async function seedDatabase() {
	const core = await import(pathToFileURL(CORE_DIST).href);
	const config = core.loadConfig(CONFIG_PATH);
	const pool = core.getWorkerPool(config.gcp.cloud_sql);
	await core.runMigrations(pool, MIGRATIONS_DIR);

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		await client.query('DELETE FROM api_sessions WHERE user_id IN (SELECT id FROM api_users WHERE lower(email) IN ($1, $2))', [
			OWNER_EMAIL,
			INVITE_EMAIL,
		]);
		await client.query('DELETE FROM api_invitations WHERE lower(email) IN ($1, $2) OR token_hash = $3', [
			OWNER_EMAIL,
			INVITE_EMAIL,
			hashToken(INVITE_TOKEN),
		]);
		await client.query('DELETE FROM api_users WHERE lower(email) IN ($1, $2)', [OWNER_EMAIL, INVITE_EMAIL]);

		await client.query('DELETE FROM entity_edges WHERE id = ANY($1::uuid[])', [EDGE_IDS]);
		await client.query('DELETE FROM story_entities WHERE story_id = ANY($1::uuid[])', [STORY_IDS]);
		await client.query('DELETE FROM entity_aliases WHERE entity_id = ANY($1::uuid[])', [Object.values(ENTITY_IDS)]);
		await client.query('DELETE FROM chunks WHERE story_id = ANY($1::uuid[])', [STORY_IDS]);
		await client.query('DELETE FROM stories WHERE id = ANY($1::uuid[])', [STORY_IDS]);
		await client.query('DELETE FROM source_steps WHERE source_id = $1', [SOURCE_ID]);
		await client.query('DELETE FROM sources WHERE id = $1 OR file_hash = $2', [
			SOURCE_ID,
			'mulder-demo-e2e-native-text-sample',
		]);
		await client.query('DELETE FROM entities WHERE id = ANY($1::uuid[])', [Object.values(ENTITY_IDS)]);

		await client.query(
			[
				'INSERT INTO api_users (email, password_hash, role)',
				"VALUES ($1, $2, 'owner')",
			].join(' '),
			[OWNER_EMAIL, hashPassword(OWNER_PASSWORD)],
		);
		await client.query(
			[
				'INSERT INTO api_invitations (email, role, token_hash, expires_at)',
				"VALUES ($1, 'member', $2, now() + interval '1 day')",
			].join(' '),
			[INVITE_EMAIL, hashToken(INVITE_TOKEN)],
		);

		await client.query(
			[
				'INSERT INTO sources',
				'(id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, metadata, created_at, updated_at)',
				"VALUES ($1, 'mulder-demo-case-file.pdf', $2, $3, 3, TRUE, 0.97, 'embedded', $4::jsonb, $5, $5)",
			].join(' '),
			[
				SOURCE_ID,
				`raw/${SOURCE_ID}/original.pdf`,
				'mulder-demo-e2e-native-text-sample',
				JSON.stringify({ e2e: true }),
				'2026-04-27T12:00:00.000Z',
			],
		);
		for (const [index, step] of ['extract', 'segment', 'enrich', 'embed'].entries()) {
			await client.query(
				[
					'INSERT INTO source_steps (source_id, step_name, status, completed_at)',
					"VALUES ($1, $2, 'completed', $3)",
				].join(' '),
				[SOURCE_ID, step, new Date(Date.UTC(2026, 3, 27, 12, index + 1, 0))],
			);
		}

		const stories = [
			[STORY_IDS[0], 'Project Blue Book notes', 'en', 'case_note', 1, 1],
			[STORY_IDS[1], 'Hynek interview transcript', 'en', 'interview', 2, 2],
			[STORY_IDS[2], 'Archive follow-up', 'en', 'follow_up', 3, 3],
		];
		for (const [id, title, language, category, pageStart, pageEnd] of stories) {
			await client.query(
				[
					'INSERT INTO stories',
					'(id, source_id, title, language, category, page_start, page_end, gcs_markdown_uri, gcs_metadata_uri, chunk_count, extraction_confidence, status, metadata, created_at, updated_at)',
					"VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 0.94, 'embedded', '{}'::jsonb, $10, $10)",
				].join(' '),
				[
					id,
					SOURCE_ID,
					title,
					language,
					category,
					pageStart,
					pageEnd,
					`segments/${SOURCE_ID}/${id}.md`,
					`segments/${SOURCE_ID}/${id}.meta.json`,
					'2026-04-27T12:10:00.000Z',
				],
			);
		}

		const entities = [
			[ENTITY_IDS.hynek, 'Josef Allen Hynek', 'person', { role: 'astronomer' }, 0.86, 3],
			[ENTITY_IDS.area51, 'Area 51', 'location', { region: 'Nevada' }, 0.74, 4],
			[ENTITY_IDS.arnold, 'Kenneth Arnold', 'person', { role: 'witness' }, 0.65, 2],
			[ENTITY_IDS.blueBook, 'Project Blue Book', 'organization', { type: 'research program' }, 0.81, 5],
		];
		for (const [id, name, type, attributes, score, sourceCount] of entities) {
			await client.query(
				[
					'INSERT INTO entities',
					'(id, name, type, attributes, corroboration_score, source_count, taxonomy_status, created_at, updated_at)',
					"VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'curated', $7, $7)",
				].join(' '),
				[id, name, type, JSON.stringify(attributes), score, sourceCount, '2026-04-27T12:15:00.000Z'],
			);
		}

		const aliases = [
			[ENTITY_IDS.hynek, 'Dr. Hynek', 'manual'],
			[ENTITY_IDS.hynek, 'J. Allen Hynek', 'extraction'],
			[ENTITY_IDS.area51, 'Groom Lake', 'manual'],
			[ENTITY_IDS.blueBook, 'USAF Project Blue Book', 'manual'],
		];
		for (const [entityId, alias, source] of aliases) {
			await client.query(
				'INSERT INTO entity_aliases (entity_id, alias, source) VALUES ($1, $2, $3)',
				[entityId, alias, source],
			);
		}

		const storyEntities = [
			[STORY_IDS[0], ENTITY_IDS.hynek, 0.95, 2],
			[STORY_IDS[0], ENTITY_IDS.area51, 0.9, 1],
			[STORY_IDS[0], ENTITY_IDS.blueBook, 0.93, 1],
			[STORY_IDS[1], ENTITY_IDS.hynek, 0.94, 2],
			[STORY_IDS[1], ENTITY_IDS.arnold, 0.88, 1],
			[STORY_IDS[1], ENTITY_IDS.area51, 0.84, 1],
			[STORY_IDS[2], ENTITY_IDS.blueBook, 0.91, 1],
			[STORY_IDS[2], ENTITY_IDS.area51, 0.86, 1],
			[STORY_IDS[2], ENTITY_IDS.arnold, 0.82, 1],
		];
		for (const [storyId, entityId, confidence, mentionCount] of storyEntities) {
			await client.query(
				'INSERT INTO story_entities (story_id, entity_id, confidence, mention_count) VALUES ($1, $2, $3, $4)',
				[storyId, entityId, confidence, mentionCount],
			);
		}

		await client.query(
			[
				'INSERT INTO entity_edges',
				'(id, source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type)',
				"VALUES ($1, $2, $3, 'INVESTIGATED_AT', '{}'::jsonb, 0.84, $4, 'RELATIONSHIP')",
			].join(' '),
			[EDGE_IDS[0], ENTITY_IDS.hynek, ENTITY_IDS.area51, STORY_IDS[0]],
		);
		await client.query(
			[
				'INSERT INTO entity_edges',
				'(id, source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type)',
				"VALUES ($1, $2, $3, 'REFERENCED_BY', '{}'::jsonb, 0.78, $4, 'RELATIONSHIP')",
			].join(' '),
			[EDGE_IDS[1], ENTITY_IDS.arnold, ENTITY_IDS.blueBook, STORY_IDS[2]],
		);

		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
		await core.closeAllPools();
	}
}

buildPackages();
writeStorageArtifacts();
await seedDatabase();

console.log(`Seeded Mulder demo E2E fixture: ${SOURCE_ID}`);
