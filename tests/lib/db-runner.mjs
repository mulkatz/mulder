import pg from 'pg';

const PGHOST = process.env.PGHOST ?? 'localhost';
const PGPORT = Number.parseInt(process.env.PGPORT ?? '5432', 10);
const PGUSER = process.env.PGUSER ?? 'mulder';
const PGPASSWORD = process.env.PGPASSWORD ?? 'mulder';
const PGDATABASE = process.env.PGDATABASE ?? 'mulder';

function formatArrayValue(value) {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	if (Array.isArray(value)) {
		return `{${value.map(formatArrayValue).join(',')}}`;
	}
	if (typeof value === 'string') {
		if (/[{}",\\\s]/.test(value)) {
			return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
		}
		return value;
	}
	if (typeof value === 'boolean') {
		return value ? 't' : 'f';
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function formatField(value) {
	if (value === null || value === undefined) {
		return '';
	}
	if (Array.isArray(value)) {
		return `{${value.map(formatArrayValue).join(',')}}`;
	}
	if (typeof value === 'boolean') {
		return value ? 't' : 'f';
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Buffer.isBuffer(value)) {
		return value.toString('utf8');
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function normalizeResult(result) {
	if (Array.isArray(result)) {
		return result[result.length - 1] ?? null;
	}
	return result;
}

const client = new pg.Client({
	host: PGHOST,
	port: PGPORT,
	user: PGUSER,
	password: PGPASSWORD,
	database: PGDATABASE,
});

try {
	await client.connect();

	const command = process.argv[2];
	if (command === 'ready') {
		await client.query('SELECT 1;');
		process.exit(0);
	}

	if (command !== 'query') {
		throw new Error(`Unknown db-runner command: ${command ?? '<missing>'}`);
	}

	const encodedSql = process.argv[3] ?? '';
	const sql = Buffer.from(encodedSql, 'base64').toString('utf8');
	const result = normalizeResult(await client.query(sql));

	if (!result || !Array.isArray(result.rows) || result.rows.length === 0) {
		process.stdout.write('');
		process.exit(0);
	}

	const rows = result.rows.map((row) => Object.values(row).map(formatField).join('|')).join('\n');
	process.stdout.write(rows);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
} finally {
	await client.end().catch(() => {});
}
