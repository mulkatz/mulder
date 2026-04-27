import { spawnSync } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = resolve(SCRIPT_DIR, '../..');
const ROOT = resolve(DEMO_DIR, '..');
const CONFIG_PATH = resolve(DEMO_DIR, 'tests/config/mulder.e2e.config.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');
const STORAGE_DIR = resolve(ROOT, '.local/storage');
const FIXTURE_PDF = resolve(ROOT, 'fixtures/raw/native-text-sample.pdf');
const SESSION_SECRET = 'mulder-e2e-session-secret';
const OWNER_EMAIL = 'owner.e2e@mulder.local';
const OWNER_PASSWORD = 'correct horse battery staple';
const INVITE_EMAIL = 'invite.e2e@mulder.local';
const INVITE_TOKEN = 'mulder-e2e-invite-token';
const PAGE_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8efMmAwAIAgK1Z9hQJwAAAABJRU5ErkJggg==';

const ENTITY_IDS = {
	hynek: '33333333-3333-4333-8333-333333333331',
	area51: '33333333-3333-4333-8333-333333333332',
	arnold: '33333333-3333-4333-8333-333333333333',
	blueBook: '33333333-3333-4333-8333-333333333334',
	cufos: '33333333-3333-4333-8333-333333333335',
	phoenixLights: '33333333-3333-4333-8333-333333333336',
	roswell: '33333333-3333-4333-8333-333333333337',
	vallee: '33333333-3333-4333-8333-333333333338',
	nationalArchives: '33333333-3333-4333-8333-333333333339',
	nellisRange: '33333333-3333-4333-8333-33333333333a',
	mufon: '33333333-3333-4333-8333-33333333333b',
	hynekCard: '33333333-3333-4333-8333-33333333333c',
};

const EDGE_IDS = [
	'44444444-4444-4444-8444-444444444441',
	'44444444-4444-4444-8444-444444444442',
	'44444444-4444-4444-8444-444444444443',
	'44444444-4444-4444-8444-444444444444',
	'44444444-4444-4444-8444-444444444445',
	'44444444-4444-4444-8444-444444444446',
	'44444444-4444-4444-8444-444444444447',
	'44444444-4444-4444-8444-444444444448',
	'44444444-4444-4444-8444-444444444449',
	'44444444-4444-4444-8444-44444444444a',
	'44444444-4444-4444-8444-44444444444b',
];

const CHAIN_IDS = [
	'55555555-5555-4555-8555-555555555551',
	'55555555-5555-4555-8555-555555555552',
	'55555555-5555-4555-8555-555555555553',
];

const CLUSTER_IDS = [
	'66666666-6666-4666-8666-666666666661',
	'66666666-6666-4666-8666-666666666662',
];

const JOB_IDS = [
	'77777777-7777-4777-8777-777777777771',
	'77777777-7777-4777-8777-777777777772',
	'77777777-7777-4777-8777-777777777773',
];

const DEMO_SOURCES = [
	{
		id: '11111111-1111-4111-8111-111111111111',
		filename: 'mulder-demo-case-file.pdf',
		fileHash: fileHashForFixture(),
		status: 'analyzed',
		reliability: 0.82,
		createdAt: '2026-04-27T12:00:00.000Z',
		tags: ['demo', 'blue-book'],
		stories: [
			{
				id: '22222222-2222-4222-8222-222222222221',
				title: 'Project Blue Book notes',
				category: 'case_note',
				pageStart: 1,
				pageEnd: 1,
				content:
					'Josef Allen Hynek reviewed reports from Area 51 with Project Blue Book investigators. The notes describe a careful attempt to separate witness claims from archival records.',
			},
			{
				id: '22222222-2222-4222-8222-222222222222',
				title: 'Hynek interview transcript',
				category: 'interview',
				pageStart: 2,
				pageEnd: 2,
				content:
					'J. Allen Hynek compared Kenneth Arnold sightings with Area 51 rumors in a later interview. Hynek emphasized that repeated names matter only when tied back to documents.',
			},
			{
				id: '22222222-2222-4222-8222-222222222223',
				title: 'Archive follow-up',
				category: 'follow_up',
				pageStart: 3,
				pageEnd: 3,
				content:
					'Project Blue Book staff returned to Area 51 references after Kenneth Arnold appeared in the index. The follow-up created a clean chain from person to location to source.',
			},
		],
	},
	{
		id: '11111111-1111-4111-8111-111111111112',
		filename: 'phoenix-lights-field-notes.pdf',
		fileHash: 'mulder-demo-fixture-phoenix-lights',
		status: 'graphed',
		reliability: 0.68,
		createdAt: '2026-04-26T15:20:00.000Z',
		tags: ['demo', 'phoenix'],
		stories: [
			{
				id: '22222222-2222-4222-8222-222222222224',
				title: 'Phoenix Lights witness grid',
				category: 'field_note',
				pageStart: 1,
				pageEnd: 2,
				content:
					'The Phoenix Lights witness grid links multiple reports to a common corridor over Arizona. MUFON volunteers logged timestamps that disagree with a National Archives digest.',
			},
			{
				id: '22222222-2222-4222-8222-222222222225',
				title: 'Arizona follow-up call',
				category: 'call_log',
				pageStart: 3,
				pageEnd: 3,
				content:
					'A follow-up call describes Phoenix Lights witnesses using similar language about a silent triangular formation. The summary cites MUFON and the National Archives as independent records.',
			},
		],
	},
	{
		id: '11111111-1111-4111-8111-111111111113',
		filename: 'roswell-archive-index.pdf',
		fileHash: 'mulder-demo-fixture-roswell-index',
		status: 'analyzed',
		reliability: 0.74,
		createdAt: '2026-04-25T09:45:00.000Z',
		tags: ['demo', 'roswell'],
		stories: [
			{
				id: '22222222-2222-4222-8222-222222222226',
				title: 'Roswell archive index card',
				category: 'index_card',
				pageStart: 1,
				pageEnd: 1,
				content:
					'The Roswell index card places several recovered-material claims near the National Archives collection. Jacques Vallee later noted that index cards can preserve provenance but not certainty.',
			},
			{
				id: '22222222-2222-4222-8222-222222222227',
				title: 'National Archives transfer note',
				category: 'archive_note',
				pageStart: 2,
				pageEnd: 3,
				content:
					'The National Archives transfer note labels the Roswell packet as administrative correspondence. It does not corroborate a recovered craft claim, but it confirms a custody chain.',
			},
		],
	},
	{
		id: '11111111-1111-4111-8111-111111111114',
		filename: 'nellis-range-observation-log.pdf',
		fileHash: 'mulder-demo-fixture-nellis-range',
		status: 'embedded',
		reliability: 0.59,
		createdAt: '2026-04-24T18:30:00.000Z',
		tags: ['demo', 'area-51'],
		stories: [
			{
				id: '22222222-2222-4222-8222-222222222228',
				title: 'Nellis Range radar excerpt',
				category: 'radar_log',
				pageStart: 1,
				pageEnd: 2,
				content:
					'Nellis Range radar operators logged an unusual return near Area 51. The same night appears in a Project Blue Book memorandum with lower confidence language.',
			},
			{
				id: '22222222-2222-4222-8222-222222222229',
				title: 'Groom Lake maintenance note',
				category: 'maintenance_note',
				pageStart: 3,
				pageEnd: 3,
				content:
					'A Groom Lake maintenance note mentions Nellis Range access restrictions and a delayed runway inspection. It gives mundane context for one Area 51 rumor chain.',
			},
		],
	},
	{
		id: '11111111-1111-4111-8111-111111111115',
		filename: 'cufos-investigator-memo.pdf',
		fileHash: 'mulder-demo-fixture-cufos-memo',
		status: 'analyzed',
		reliability: 0.77,
		createdAt: '2026-04-23T11:05:00.000Z',
		tags: ['demo', 'cufos'],
		stories: [
			{
				id: '22222222-2222-4222-8222-22222222222a',
				title: 'CUFOS investigator memo',
				category: 'memo',
				pageStart: 1,
				pageEnd: 1,
				content:
					'CUFOS investigators compared Josef Allen Hynek correspondence with Project Blue Book summaries. The memo flags the Hynek archive card as a likely duplicate identity record.',
			},
			{
				id: '22222222-2222-4222-8222-22222222222b',
				title: 'Vallee correspondence excerpt',
				category: 'correspondence',
				pageStart: 2,
				pageEnd: 3,
				content:
					'Jacques Vallee wrote that witness clusters become useful only when citations survive. His note links CUFOS, Hynek, Phoenix Lights, and Roswell into a cautious research thread.',
			},
		],
	},
];

const packagesToBuild = [
	'@mulder/core',
	'@mulder/taxonomy',
	'@mulder/retrieval',
	'@mulder/pipeline',
	'@mulder/worker',
	'@mulder/evidence',
	'@mulder/api',
	'@mulder/cli',
];

function fileHashForFixture() {
	return createHash('sha256').update(readFileSync(FIXTURE_PDF)).digest('hex');
}

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

function sourceIds() {
	return DEMO_SOURCES.map((source) => source.id);
}

function storyIds() {
	return DEMO_SOURCES.flatMap((source) => source.stories.map((story) => story.id));
}

function writeStorageArtifacts() {
	const pagePng = Buffer.from(PAGE_PNG_BASE64, 'base64');

	for (const source of DEMO_SOURCES) {
		const rawDir = resolve(STORAGE_DIR, `raw/${source.id}`);
		const extractedDir = resolve(STORAGE_DIR, `extracted/${source.id}`);
		const pagesDir = resolve(extractedDir, 'pages');

		mkdirSync(rawDir, { recursive: true });
		mkdirSync(pagesDir, { recursive: true });
		copyFileSync(FIXTURE_PDF, resolve(rawDir, 'original.pdf'));

		writeFileSync(
			resolve(extractedDir, 'layout.md'),
			source.stories
				.flatMap((story) => [
					`# ${story.title}`,
					'',
					story.content,
					'',
				])
				.join('\n'),
		);

		for (let page = 1; page <= 3; page += 1) {
			writeFileSync(resolve(pagesDir, `page-${String(page).padStart(3, '0')}.png`), pagePng);
		}
	}
}

async function deleteFixtureRows(client) {
	const sources = sourceIds();
	const stories = storyIds();
	const entities = Object.values(ENTITY_IDS);
	const fileHashes = DEMO_SOURCES.map((source) => source.fileHash).concat('mulder-demo-e2e-native-text-sample');

	await client.query(
		`
			DELETE FROM jobs
			WHERE id = ANY($1::uuid[])
				OR COALESCE(payload->>'sourceId', payload->>'source_id') = ANY($2::text[])
				OR (type = 'document_upload_finalize' AND payload->>'filename' = ANY($3::text[]))
		`,
		[JOB_IDS, sources, ['native-text-sample.pdf', 'mulder-demo-upload.pdf']],
	);
	await client.query('DELETE FROM evidence_chains WHERE id = ANY($1::uuid[])', [CHAIN_IDS]);
	await client.query('DELETE FROM spatio_temporal_clusters WHERE id = ANY($1::uuid[])', [CLUSTER_IDS]);
	await client.query(
		`
			DELETE FROM entity_edges
			WHERE id = ANY($1::uuid[])
				OR story_id = ANY($2::uuid[])
				OR source_entity_id = ANY($3::uuid[])
				OR target_entity_id = ANY($3::uuid[])
		`,
		[EDGE_IDS, stories, entities],
	);
	await client.query(
		`
			DELETE FROM story_entities
			WHERE story_id = ANY($1::uuid[])
				OR entity_id = ANY($2::uuid[])
		`,
		[stories, entities],
	);
	await client.query('DELETE FROM entity_aliases WHERE entity_id = ANY($1::uuid[])', [entities]);
	await client.query(
		'DELETE FROM chunks WHERE story_id = ANY($1::uuid[]) OR story_id IN (SELECT id FROM stories WHERE source_id = ANY($2::uuid[]))',
		[stories, sources],
	);
	await client.query('DELETE FROM stories WHERE id = ANY($1::uuid[]) OR source_id = ANY($2::uuid[])', [
		stories,
		sources,
	]);
	await client.query('DELETE FROM source_steps WHERE source_id = ANY($1::uuid[])', [sources]);
	await client.query('DELETE FROM sources WHERE id = ANY($1::uuid[]) OR file_hash = ANY($2::text[])', [
		sources,
		fileHashes,
	]);
	await client.query('DELETE FROM entities WHERE id = ANY($1::uuid[])', [entities]);
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
}

async function seedUsers(client) {
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
}

async function seedSources(client) {
	for (const source of DEMO_SOURCES) {
		await client.query(
			[
				'INSERT INTO sources',
				'(id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata, created_at, updated_at)',
				'VALUES ($1, $2, $3, $4, 3, TRUE, 0.97, $5, $6, $7::text[], $8::jsonb, $9, $9)',
			].join(' '),
			[
				source.id,
				source.filename,
				`raw/${source.id}/original.pdf`,
				source.fileHash,
				source.status,
				source.reliability,
				source.tags,
				JSON.stringify({ e2e: true, fixture: 'full-functional-demo' }),
				source.createdAt,
			],
		);

		for (const [index, step] of ['extract', 'segment', 'enrich', 'embed', 'graph'].entries()) {
			await client.query(
				[
					'INSERT INTO source_steps (source_id, step_name, status, completed_at)',
					"VALUES ($1, $2, 'completed', $3)",
				].join(' '),
				[source.id, step, new Date(new Date(source.createdAt).getTime() + (index + 1) * 60_000)],
			);
		}

		for (const story of source.stories) {
			await client.query(
				[
					'INSERT INTO stories',
					'(id, source_id, title, language, category, page_start, page_end, gcs_markdown_uri, gcs_metadata_uri, chunk_count, extraction_confidence, status, metadata, created_at, updated_at)',
					"VALUES ($1, $2, $3, 'en', $4, $5, $6, $7, $8, 1, 0.94, 'embedded', $9::jsonb, $10, $10)",
				].join(' '),
				[
					story.id,
					source.id,
					story.title,
					story.category,
					story.pageStart,
					story.pageEnd,
					`segments/${source.id}/${story.id}.md`,
					`segments/${source.id}/${story.id}.meta.json`,
					JSON.stringify({
						source_filename: source.filename,
						date_references: ['2026-04-27'],
						geographic_references: story.content.includes('Phoenix') ? ['Arizona'] : ['Nevada'],
					}),
					new Date(new Date(source.createdAt).getTime() + 10 * 60_000),
				],
			);
			await client.query(
				[
					'INSERT INTO chunks',
					'(story_id, content, chunk_index, page_start, page_end, is_question, metadata)',
					'VALUES ($1, $2, 0, $3, $4, FALSE, $5::jsonb)',
				].join(' '),
				[
					story.id,
					`${story.title}. ${story.content}`,
					story.pageStart,
					story.pageEnd,
					JSON.stringify({
						source_id: source.id,
						source_filename: source.filename,
						story_title: story.title,
						page_start: story.pageStart,
						page_end: story.pageEnd,
					}),
				],
			);
		}
	}
}

async function seedEntities(client) {
	const entities = [
		[ENTITY_IDS.hynek, 'Josef Allen Hynek', 'person', { role: 'astronomer' }, 0.86, 3],
		[ENTITY_IDS.area51, 'Area 51', 'location', { region: 'Nevada' }, 0.74, 4],
		[ENTITY_IDS.arnold, 'Kenneth Arnold', 'person', { role: 'witness' }, 0.65, 2],
		[ENTITY_IDS.blueBook, 'Project Blue Book', 'organization', { type: 'research program' }, 0.81, 5],
		[ENTITY_IDS.cufos, 'CUFOS', 'organization', { type: 'research archive' }, 0.72, 2],
		[ENTITY_IDS.phoenixLights, 'Phoenix Lights', 'event', { date: '1997-03-13' }, 0.7, 2],
		[ENTITY_IDS.roswell, 'Roswell', 'location', { region: 'New Mexico' }, 0.66, 2],
		[ENTITY_IDS.vallee, 'Jacques Vallee', 'person', { role: 'researcher' }, 0.69, 2],
		[ENTITY_IDS.nationalArchives, 'National Archives', 'organization', { type: 'archive' }, 0.79, 3],
		[ENTITY_IDS.nellisRange, 'Nellis Range', 'location', { region: 'Nevada' }, 0.61, 2],
		[ENTITY_IDS.mufon, 'MUFON', 'organization', { type: 'volunteer network' }, 0.58, 2],
		[ENTITY_IDS.hynekCard, 'Hynek archive card', 'person', { role: 'duplicate record candidate' }, 0.42, 1],
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
		[ENTITY_IDS.hynek, 'Josef Allen Hynek', 'manual'],
		[ENTITY_IDS.hynek, 'Dr. Hynek', 'manual'],
		[ENTITY_IDS.hynek, 'J. Allen Hynek', 'extraction'],
		[ENTITY_IDS.hynek, 'hynek', 'manual'],
		[ENTITY_IDS.area51, 'Area 51', 'manual'],
		[ENTITY_IDS.area51, 'Groom Lake', 'manual'],
		[ENTITY_IDS.blueBook, 'Project Blue Book', 'manual'],
		[ENTITY_IDS.blueBook, 'USAF Project Blue Book', 'manual'],
		[ENTITY_IDS.arnold, 'Kenneth Arnold', 'manual'],
		[ENTITY_IDS.cufos, 'CUFOS', 'manual'],
		[ENTITY_IDS.phoenixLights, 'Phoenix Lights', 'manual'],
		[ENTITY_IDS.roswell, 'Roswell', 'manual'],
		[ENTITY_IDS.vallee, 'Jacques Vallee', 'manual'],
		[ENTITY_IDS.nationalArchives, 'National Archives', 'manual'],
		[ENTITY_IDS.nellisRange, 'Nellis Range', 'manual'],
		[ENTITY_IDS.mufon, 'MUFON', 'manual'],
	];
	for (const [entityId, alias, source] of aliases) {
		await client.query('INSERT INTO entity_aliases (entity_id, alias, source) VALUES ($1, $2, $3)', [
			entityId,
			alias,
			source,
		]);
	}

	const links = [
		['22222222-2222-4222-8222-222222222221', ENTITY_IDS.hynek, 0.95, 2],
		['22222222-2222-4222-8222-222222222221', ENTITY_IDS.area51, 0.9, 1],
		['22222222-2222-4222-8222-222222222221', ENTITY_IDS.blueBook, 0.93, 1],
		['22222222-2222-4222-8222-222222222222', ENTITY_IDS.hynek, 0.94, 2],
		['22222222-2222-4222-8222-222222222222', ENTITY_IDS.arnold, 0.88, 1],
		['22222222-2222-4222-8222-222222222222', ENTITY_IDS.area51, 0.84, 1],
		['22222222-2222-4222-8222-222222222223', ENTITY_IDS.blueBook, 0.91, 1],
		['22222222-2222-4222-8222-222222222223', ENTITY_IDS.area51, 0.86, 1],
		['22222222-2222-4222-8222-222222222223', ENTITY_IDS.arnold, 0.82, 1],
		['22222222-2222-4222-8222-222222222224', ENTITY_IDS.phoenixLights, 0.92, 3],
		['22222222-2222-4222-8222-222222222224', ENTITY_IDS.mufon, 0.81, 1],
		['22222222-2222-4222-8222-222222222224', ENTITY_IDS.nationalArchives, 0.7, 1],
		['22222222-2222-4222-8222-222222222225', ENTITY_IDS.phoenixLights, 0.89, 2],
		['22222222-2222-4222-8222-222222222225', ENTITY_IDS.mufon, 0.85, 1],
		['22222222-2222-4222-8222-222222222225', ENTITY_IDS.nationalArchives, 0.74, 1],
		['22222222-2222-4222-8222-222222222226', ENTITY_IDS.roswell, 0.9, 2],
		['22222222-2222-4222-8222-222222222226', ENTITY_IDS.nationalArchives, 0.88, 1],
		['22222222-2222-4222-8222-222222222226', ENTITY_IDS.vallee, 0.76, 1],
		['22222222-2222-4222-8222-222222222227', ENTITY_IDS.roswell, 0.84, 1],
		['22222222-2222-4222-8222-222222222227', ENTITY_IDS.nationalArchives, 0.91, 2],
		['22222222-2222-4222-8222-222222222228', ENTITY_IDS.nellisRange, 0.87, 1],
		['22222222-2222-4222-8222-222222222228', ENTITY_IDS.area51, 0.83, 1],
		['22222222-2222-4222-8222-222222222228', ENTITY_IDS.blueBook, 0.78, 1],
		['22222222-2222-4222-8222-222222222229', ENTITY_IDS.nellisRange, 0.82, 1],
		['22222222-2222-4222-8222-222222222229', ENTITY_IDS.area51, 0.8, 1],
		['22222222-2222-4222-8222-22222222222a', ENTITY_IDS.cufos, 0.93, 2],
		['22222222-2222-4222-8222-22222222222a', ENTITY_IDS.hynek, 0.89, 1],
		['22222222-2222-4222-8222-22222222222a', ENTITY_IDS.blueBook, 0.77, 1],
		['22222222-2222-4222-8222-22222222222a', ENTITY_IDS.hynekCard, 0.68, 1],
		['22222222-2222-4222-8222-22222222222b', ENTITY_IDS.vallee, 0.89, 1],
		['22222222-2222-4222-8222-22222222222b', ENTITY_IDS.cufos, 0.82, 1],
		['22222222-2222-4222-8222-22222222222b', ENTITY_IDS.phoenixLights, 0.72, 1],
		['22222222-2222-4222-8222-22222222222b', ENTITY_IDS.roswell, 0.71, 1],
	];
	for (const [storyId, entityId, confidence, mentionCount] of links) {
		await client.query('INSERT INTO story_entities (story_id, entity_id, confidence, mention_count) VALUES ($1, $2, $3, $4)', [
			storyId,
			entityId,
			confidence,
			mentionCount,
		]);
	}
}

async function seedEdgesAndEvidence(client) {
	const edges = [
		[EDGE_IDS[0], ENTITY_IDS.hynek, ENTITY_IDS.area51, 'INVESTIGATED_AT', 'RELATIONSHIP', 0.84, '22222222-2222-4222-8222-222222222221', {}, null],
		[EDGE_IDS[1], ENTITY_IDS.arnold, ENTITY_IDS.blueBook, 'REFERENCED_BY', 'RELATIONSHIP', 0.78, '22222222-2222-4222-8222-222222222223', {}, null],
		[EDGE_IDS[2], ENTITY_IDS.phoenixLights, ENTITY_IDS.mufon, 'LOGGED_BY', 'RELATIONSHIP', 0.81, '22222222-2222-4222-8222-222222222224', {}, null],
		[EDGE_IDS[3], ENTITY_IDS.roswell, ENTITY_IDS.nationalArchives, 'HELD_BY', 'RELATIONSHIP', 0.77, '22222222-2222-4222-8222-222222222226', {}, null],
		[EDGE_IDS[4], ENTITY_IDS.nellisRange, ENTITY_IDS.area51, 'NEAR', 'RELATIONSHIP', 0.73, '22222222-2222-4222-8222-222222222228', {}, null],
		[EDGE_IDS[5], ENTITY_IDS.vallee, ENTITY_IDS.cufos, 'CORRESPONDED_WITH', 'RELATIONSHIP', 0.76, '22222222-2222-4222-8222-22222222222b', {}, null],
		[EDGE_IDS[6], ENTITY_IDS.hynekCard, ENTITY_IDS.hynek, 'DUPLICATE_OF', 'DUPLICATE_OF', 0.91, '22222222-2222-4222-8222-22222222222a', { reason: 'same archive card identity' }, null],
		[
			EDGE_IDS[7],
			ENTITY_IDS.phoenixLights,
			ENTITY_IDS.nationalArchives,
			'EVENT_TIME',
			'POTENTIAL_CONTRADICTION',
			0.69,
			'22222222-2222-4222-8222-222222222224',
			{ attribute: 'event_time', valueA: '20:30 local', valueB: '22:00 local' },
			{ verdict: 'confirmed', winning_claim: 'neither', confidence: 0.62, explanation: 'Two independent records disagree on the first reliable timestamp.' },
		],
		[
			EDGE_IDS[8],
			ENTITY_IDS.roswell,
			ENTITY_IDS.nationalArchives,
			'CLAIM_TYPE',
			'CONFIRMED_CONTRADICTION',
			0.72,
			'22222222-2222-4222-8222-222222222227',
			{ attribute: 'claim_type', valueA: 'recovered craft', valueB: 'administrative correspondence' },
			{ verdict: 'confirmed', winning_claim: 'B', confidence: 0.74, explanation: 'The archive note supports custody, not the recovered-craft claim.' },
		],
		[
			EDGE_IDS[9],
			ENTITY_IDS.nellisRange,
			ENTITY_IDS.blueBook,
			'REPORT_LANGUAGE',
			'DISMISSED_CONTRADICTION',
			0.55,
			'22222222-2222-4222-8222-222222222228',
			{ attribute: 'confidence_language', valueA: 'unusual return', valueB: 'low confidence memorandum' },
			{ verdict: 'dismissed', winning_claim: 'neither', confidence: 0.67, explanation: 'The records use different confidence language but do not make mutually exclusive claims.' },
		],
		[EDGE_IDS[10], ENTITY_IDS.vallee, ENTITY_IDS.roswell, 'COMMENTED_ON', 'RELATIONSHIP', 0.66, '22222222-2222-4222-8222-222222222226', {}, null],
	];

	for (const [id, sourceEntityId, targetEntityId, relationship, edgeType, confidence, storyId, attributes, analysis] of edges) {
		await client.query(
			[
				'INSERT INTO entity_edges',
				'(id, source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis)',
				'VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)',
			].join(' '),
			[
				id,
				sourceEntityId,
				targetEntityId,
				relationship,
				JSON.stringify(attributes),
				confidence,
				storyId,
				edgeType,
				analysis ? JSON.stringify(analysis) : null,
			],
		);
	}

	const chains = [
		[CHAIN_IDS[0], 'Hynek connects Project Blue Book records to Area 51 references', [ENTITY_IDS.hynek, EDGE_IDS[0], ENTITY_IDS.area51, ENTITY_IDS.blueBook], 0.82, true],
		[CHAIN_IDS[1], 'Phoenix Lights timestamps remain internally contested', [ENTITY_IDS.phoenixLights, EDGE_IDS[7], ENTITY_IDS.nationalArchives], 0.64, true],
		[CHAIN_IDS[2], 'Roswell archive custody supports provenance but not recovered-craft claims', [ENTITY_IDS.roswell, EDGE_IDS[8], ENTITY_IDS.nationalArchives], 0.71, false],
	];
	for (const [id, thesis, path, strength, supports] of chains) {
		await client.query(
			'INSERT INTO evidence_chains (id, thesis, path, strength, supports, computed_at) VALUES ($1, $2, $3::uuid[], $4, $5, $6)',
			[id, thesis, path, strength, supports, '2026-04-27T13:00:00.000Z'],
		);
	}

	const clusters = [
		[
			CLUSTER_IDS[0],
			33.4484,
			-112.074,
			'1997-03-13T19:00:00.000Z',
			'1997-03-14T02:00:00.000Z',
			2,
			['22222222-2222-4222-8222-222222222224', '22222222-2222-4222-8222-222222222225'],
			'temporal',
		],
		[
			CLUSTER_IDS[1],
			37.2431,
			-115.793,
			'2026-04-24T00:00:00.000Z',
			'2026-04-27T00:00:00.000Z',
			3,
			['22222222-2222-4222-8222-222222222221', '22222222-2222-4222-8222-222222222228', '22222222-2222-4222-8222-222222222229'],
			'spatio-temporal',
		],
	];
	for (const [id, centerLat, centerLng, timeStart, timeEnd, eventCount, eventIds, clusterType] of clusters) {
		await client.query(
			[
				'INSERT INTO spatio_temporal_clusters',
				'(id, center_lat, center_lng, time_start, time_end, event_count, event_ids, cluster_type, computed_at)',
				'VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9)',
			].join(' '),
			[id, centerLat, centerLng, timeStart, timeEnd, eventCount, eventIds, clusterType, '2026-04-27T13:10:00.000Z'],
		);
	}
}

async function seedJobs(client) {
	const jobs = [
		[
			JOB_IDS[0],
			'extract',
			{ sourceId: DEMO_SOURCES[0].id, runId: '88888888-8888-4888-8888-888888888881', tag: 'demo-seed' },
			'completed',
			1,
			null,
			'demo-worker-1',
			'2026-04-27T12:01:00.000Z',
			'2026-04-27T12:01:15.000Z',
		],
		[
			JOB_IDS[1],
			'graph',
			{ sourceId: DEMO_SOURCES[1].id, runId: '88888888-8888-4888-8888-888888888882', tag: 'demo-seed' },
			'completed',
			1,
			null,
			'demo-worker-1',
			'2026-04-26T15:25:00.000Z',
			'2026-04-26T15:25:40.000Z',
		],
		[
			JOB_IDS[2],
			'enrich',
			{ sourceId: DEMO_SOURCES[3].id, runId: '88888888-8888-4888-8888-888888888883', tag: 'demo-seed' },
			'failed',
			3,
			'Demo fixture: upstream record required manual review before rerun.',
			'demo-worker-1',
			'2026-04-24T18:40:00.000Z',
			'2026-04-24T18:41:00.000Z',
		],
	];

	for (const [id, type, payload, status, attempts, errorLog, workerId, startedAt, finishedAt] of jobs) {
		await client.query(
			[
				'INSERT INTO jobs',
				'(id, type, payload, status, attempts, max_attempts, error_log, worker_id, created_at, started_at, finished_at)',
				'VALUES ($1, $2, $3::jsonb, $4::job_status, $5, 3, $6, $7, $8, $8, $9)',
			].join(' '),
			[id, type, JSON.stringify(payload), status, attempts, errorLog, workerId, startedAt, finishedAt],
		);
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
		await deleteFixtureRows(client);
		await seedUsers(client);
		await seedSources(client);
		await seedEntities(client);
		await seedEdgesAndEvidence(client);
		await seedJobs(client);
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

console.log(`Seeded full Mulder demo fixture: ${DEMO_SOURCES.length} sources, ${storyIds().length} stories`);
