#!/usr/bin/env node

function readOption(name) {
	const prefixed = `--${name}=`;
	const index = process.argv.indexOf(`--${name}`);
	if (index >= 0) {
		return process.argv[index + 1];
	}

	const inline = process.argv.find((arg) => arg.startsWith(prefixed));
	return inline ? inline.slice(prefixed.length) : undefined;
}

const apiUrl = (readOption('api-url') ?? process.env.MULDER_API_URL ?? 'https://api.mulder.mulkatz.dev').replace(
	/\/$/,
	'',
);
const email = readOption('email') ?? process.env.MULDER_SMOKE_EMAIL;
const password = readOption('password') ?? process.env.MULDER_SMOKE_PASSWORD;

async function expectStatus(label, request, expectedStatus) {
	const response = await fetch(request);
	if (response.status !== expectedStatus) {
		const text = await response.text().catch(() => '');
		throw new Error(`${label}: expected ${expectedStatus}, got ${response.status}${text ? `: ${text}` : ''}`);
	}
	console.log(`${label}: ${response.status}`);
	return response;
}

await expectStatus('health', `${apiUrl}/api/health`, 200);
await expectStatus('unauthenticated documents', `${apiUrl}/api/documents`, 401);

if (email && password) {
	const login = await fetch(`${apiUrl}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
	if (login.status !== 200) {
		throw new Error(`login: expected 200, got ${login.status}: ${await login.text()}`);
	}
	const cookie = login.headers.get('set-cookie')?.split(';')[0];
	if (!cookie) {
		throw new Error('login: response did not include a session cookie');
	}
	await expectStatus(
		'authenticated documents',
		new Request(`${apiUrl}/api/documents`, {
			headers: { Cookie: cookie },
		}),
		200,
	);
} else {
	console.log('authenticated documents: skipped (set MULDER_SMOKE_EMAIL and MULDER_SMOKE_PASSWORD)');
}
