/**
 * The locale files and the strings the user reads.
 *
 * The plugin ships in nine languages. Every locale file names the plugin and
 * describes it; the browser half carries English and Chinese inline, because
 * the browser cannot import JSON.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ROOT, suite } from './harness.mjs';

const run = suite('Locales and strings');

const LOCALES = ['en', 'zh', 'de', 'es', 'fr', 'ja', 'nl', 'pt', 'ru'];

await run.test('every locale file names the plugin and describes it', async () => {
	for (const locale of LOCALES) {
		const file = path.join(ROOT, 'locale', `${locale}.json`);
		const data = JSON.parse(await readFile(file, 'utf8'));
		assert.ok(data.meta?.title, `locale/${locale}.json has no meta.title`);
		assert.ok(data.meta?.description, `locale/${locale}.json has no meta.description`);
		assert.ok(
			typeof data.meta.title === 'string' && data.meta.title.trim() !== '',
			`locale/${locale}.json has an empty meta.title`,
		);
	}
});

await run.test('every locale file is valid JSON with no empty string', async () => {
	for (const locale of LOCALES) {
		const file = path.join(ROOT, 'locale', `${locale}.json`);
		const raw = await readFile(file, 'utf8');
		let data;
		try {
			data = JSON.parse(raw);
		} catch (error) {
			assert.fail(`locale/${locale}.json is not valid JSON: ${error.message}`);
		}
		const walk = (node, where) => {
			if (typeof node === 'string') {
				assert.notEqual(node.trim(), '', `locale/${locale}.json has an empty value at ${where}`);
				return;
			}
			if (node && typeof node === 'object') {
				for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
			}
		};
		walk(data, locale);
	}
});

await run.test('the browser half carries English and Chinese, and both are complete', async () => {
	const source = await readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8');
	for (const key of ['accounts.edit', 'accounts.adopt', 'accounts.test', 'accounts.remove.action']) {
		const occurrences = source.split(`'${key}'`).length - 1;
		assert.ok(occurrences >= 2, `the string ${key} is not in both dictionaries (${occurrences})`);
	}
	// Every key in the English dictionary has a Chinese counterpart: the
	// Chinese block holds the same keys, so a count that differs means one
	// of them lost a string.
	const english = source.slice(source.indexOf('\t\t\t\t\ten: {'), source.indexOf('\t\t\t\t\tzh: {'));
	const chinese = source.slice(source.indexOf('\t\t\t\t\tzh: {'), source.indexOf('\t\t\t\t}', source.indexOf('\t\t\t\t\tzh: {')));
	const englishKeys = (english.match(/^\t{5}'[a-z0-9.]+':/gm) || []).length;
	const chineseKeys = (chinese.match(/^\t{5}'[a-z0-9.]+':/gm) || []).length;
	assert.equal(chineseKeys, englishKeys, 'the Chinese dictionary has a different number of strings');
});

await run.test('the user is never asked for a term they would not know', async () => {
	const source = await readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8');
	// These may appear in the code, but never as something the user reads.
	const banned = [
		"'Impersonate",
		"'domain-wide delegation'",
		"'OAuth client id'",
		"'client secret'",
	];
	for (const phrase of banned) {
		assert.ok(!source.includes(phrase), `the user-facing strings still contain ${phrase}`);
	}
});

await run.test('the wizard offers one primary choice and keeps the rest behind a disclosure', async () => {
	const source = await readFile(path.join(ROOT, 'lib', 'client.onboarding.js'), 'utf8');
	assert.ok(source.includes("tx('wizard.choose.other')"), 'the wizard has no disclosure for the other routes');
	assert.ok(source.includes('wizard.option.oauth'), 'the wizard has no primary choice');
	assert.ok(source.includes('wizard.choose.otherHint'), 'the disclosure does not say what the other routes cost');
});

process.exit(run.report() === 0 ? 0 : 1);
