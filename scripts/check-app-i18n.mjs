#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const APP_SRC = 'apps/app/src';
const GERMAN_DISALLOWED_UI_TERMS = [
	'Admin',
	'API',
	'App',
	'Claim',
	'Claims',
	'Cluster',
	'Confidence',
	'Evidence',
	'Finding',
	'Findings',
	'First-Class',
	'Flow',
	'Flows',
	'Job',
	'Jobs',
	'Knowledge',
	'Locator',
	'Policy',
	'Policies',
	'Processing',
	'Provenance',
	'Query',
	'Queue',
	'Read-Model',
	'Read-Models',
	'Research',
	'Review',
	'Sidebar',
	'Stories',
	'Story',
	'Theme',
	'Timeline',
	'Timelines',
	'Trust',
	'Upload',
	'Worker',
	'Workspace',
];
const REQUIRED_DYNAMIC_KEYS = [
	'jobType.document_upload_finalize',
	'jobType.embed',
	'jobType.enrich',
	'jobType.extract',
	'jobType.graph',
	'jobType.pipeline_run',
	'jobType.segment',
	'jobType.unknown',
	'status.completed',
	'status.contradicted',
	'status.corroborated',
	'status.critical',
	'status.dead_letter',
	'status.failed',
	'status.future_milestone',
	'status.high',
	'status.low',
	'status.medium',
	'status.missing',
	'status.mounted_api',
	'status.mounted_partial',
	'status.pending',
	'status.queued',
	'status.running',
	'status.unknownValue',
	'status.unverified',
	'status.watching',
];
const VISIBLE_ATTRS = new Set([
	'aria-label',
	'description',
	'emptyMessage',
	'eyebrow',
	'label',
	'placeholder',
	'title',
]);

function loadTsModule(path) {
	const source = readFileSync(path, 'utf8');
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: path,
	});
	const sandbox = {
		exports: {},
		module: { exports: {} },
	};
	sandbox.exports = sandbox.module.exports;
	vm.runInNewContext(outputText, sandbox, { filename: path });
	return sandbox.module.exports;
}

function listSourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const path = `${dir}/${entry}`;
		const stats = statSync(path);
		if (stats.isDirectory()) {
			files.push(...listSourceFiles(path));
		} else if ((path.endsWith('.ts') || path.endsWith('.tsx')) && !path.endsWith('/i18n/resources.ts')) {
			files.push(path);
		}
	}
	return files;
}

function flattenKeys(obj, prefix = '') {
	return Object.entries(obj).flatMap(([key, value]) => {
		const next = prefix ? `${prefix}.${key}` : key;
		return value && typeof value === 'object' && !Array.isArray(value) ? flattenKeys(value, next) : [next];
	});
}

function flattenEntries(obj, prefix = '') {
	return Object.entries(obj).flatMap(([key, value]) => {
		const next = prefix ? `${prefix}.${key}` : key;
		return value && typeof value === 'object' && !Array.isArray(value)
			? flattenEntries(value, next)
			: [[next, String(value)]];
	});
}

function hasKey(obj, key) {
	let cursor = obj;
	for (const part of key.split('.')) {
		if (!cursor || !Object.hasOwn(cursor, part)) {
			return false;
		}
		cursor = cursor[part];
	}
	return true;
}

function readableLocation(file, node, sourceFile) {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return `${relative(process.cwd(), file)}:${line + 1}:${character + 1}`;
}

function textHasLetters(value) {
	return /[A-Za-zÄÖÜäöüß]/.test(value);
}

function isTranslationCall(node) {
	if (!ts.isCallExpression(node)) return false;
	const expression = node.expression;
	if (ts.isIdentifier(expression)) return expression.text === 't';
	if (!ts.isPropertyAccessExpression(expression)) return false;
	return (
		expression.name.text === 't' &&
		ts.isIdentifier(expression.expression) &&
		['context', 'i18n'].includes(expression.expression.text)
	);
}

function collectFromFile(file, usedKeys, hardcoded) {
	const source = readFileSync(file, 'utf8');
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);

	function visit(node) {
		if (isTranslationCall(node)) {
			const [firstArg] = node.arguments;
			if (firstArg && ts.isStringLiteral(firstArg)) {
				usedKeys.add(firstArg.text);
			}
		}

		if (ts.isJsxText(node)) {
			const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
			if (text && textHasLetters(text)) {
				hardcoded.push(`${readableLocation(file, node, sourceFile)} hardcoded JSX text "${text}"`);
			}
		}

		if (ts.isJsxAttribute(node) && VISIBLE_ATTRS.has(node.name.text)) {
			const initializer = node.initializer;
			if (initializer && ts.isStringLiteral(initializer) && textHasLetters(initializer.text)) {
				hardcoded.push(`${readableLocation(file, node, sourceFile)} hardcoded ${node.name.text}="${initializer.text}"`);
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
}

const { resources } = loadTsModule('apps/app/src/i18n/resources.ts');
const { capabilities } = loadTsModule('apps/app/src/lib/capabilities.ts');
const usedKeys = new Set();
const hardcoded = [];

for (const file of listSourceFiles(APP_SRC)) {
	collectFromFile(file, usedKeys, hardcoded);
}

for (const id of Object.keys(capabilities)) {
	usedKeys.add(`capabilities.${id.replaceAll('.', '_')}`);
}

for (const key of REQUIRED_DYNAMIC_KEYS) {
	usedKeys.add(key);
}

const en = resources.en.translation;
const de = resources.de.translation;
const missingEn = [...usedKeys].filter((key) => !hasKey(en, key)).sort();
const missingDe = [...usedKeys].filter((key) => !hasKey(de, key)).sort();
const enKeys = flattenKeys(en).sort();
const deKeys = flattenKeys(de).sort();
const onlyEn = enKeys.filter((key) => !hasKey(de, key));
const onlyDe = deKeys.filter((key) => !hasKey(en, key));
const germanEnglishLeaks = flattenEntries(de)
	.flatMap(([key, value]) =>
		GERMAN_DISALLOWED_UI_TERMS.filter((term) => {
			const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const pattern = new RegExp(`(^|[^A-Za-zÄÖÜäöüß])${escapedTerm}($|[^A-Za-zÄÖÜäöüß])`);
			return pattern.test(value);
		}).map((term) => `${key}: "${value}" contains "${term}"`),
	)
	.sort();

if (
	missingEn.length ||
	missingDe.length ||
	onlyEn.length ||
	onlyDe.length ||
	hardcoded.length ||
	germanEnglishLeaks.length
) {
	console.error('App i18n check failed.');
	if (missingEn.length) console.error(`\nMissing English keys:\n${missingEn.map((key) => `  - ${key}`).join('\n')}`);
	if (missingDe.length) console.error(`\nMissing German keys:\n${missingDe.map((key) => `  - ${key}`).join('\n')}`);
	if (onlyEn.length) console.error(`\nKeys only in English:\n${onlyEn.map((key) => `  - ${key}`).join('\n')}`);
	if (onlyDe.length) console.error(`\nKeys only in German:\n${onlyDe.map((key) => `  - ${key}`).join('\n')}`);
	if (hardcoded.length)
		console.error(`\nHardcoded visible strings:\n${hardcoded.map((item) => `  - ${item}`).join('\n')}`);
	if (germanEnglishLeaks.length)
		console.error(
			`\nEnglish UI terms in German resources:\n${germanEnglishLeaks.map((item) => `  - ${item}`).join('\n')}`,
		);
	process.exit(1);
}

console.log('App i18n check passed.');
