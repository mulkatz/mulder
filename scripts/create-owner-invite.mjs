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

const apiUrl = (readOption('api-url') ?? process.env.MULDER_API_URL ?? '').replace(/\/$/, '');
const email = readOption('email') ?? process.env.MULDER_OWNER_EMAIL;
const operatorKey = readOption('operator-key') ?? process.env.MULDER_OPERATOR_API_KEY;
const role = readOption('role') ?? 'owner';

if (!apiUrl || !email || !operatorKey) {
	console.error(
		[
			'Usage: node scripts/create-owner-invite.mjs --api-url https://api.example.test --email owner@example.test --operator-key <key>',
			'',
			'Environment alternatives:',
			'  MULDER_API_URL',
			'  MULDER_OWNER_EMAIL',
			'  MULDER_OPERATOR_API_KEY',
		].join('\n'),
	);
	process.exit(2);
}

const response = await fetch(`${apiUrl}/api/auth/invitations`, {
	method: 'POST',
	headers: {
		Authorization: `Bearer ${operatorKey}`,
		'Content-Type': 'application/json',
	},
	body: JSON.stringify({ email, role }),
});

const body = response.status === 204 ? null : await response.json().catch(() => null);
if (!response.ok) {
	console.error(JSON.stringify(body ?? { status: response.status, statusText: response.statusText }, null, 2));
	process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
console.error('Invitation requested. The raw invite token is delivered by the API via email or server-side logs.');
