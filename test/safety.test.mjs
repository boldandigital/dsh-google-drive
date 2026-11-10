/**
 * The safety invariants.
 *
 * These are the rules the plugin must never break, whatever it is asked to
 * do. They are checked against the plugin's real behaviour, through its real
 * RPC routes, with a temporary store — the machine is never touched.
 */

import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { boot, call, paths, serviceKey, suite, writeShared } from './harness.mjs';

const { suite: makeSuite } = { suite };
const run = makeSuite('Safety invariants');

const AGENT_TOOLS = [
	'google_drive_list_accounts',
	'google_drive_list_files',
	'google_drive_search_files',
	'google_drive_download_file',
	'google_drive_upload_file',
];

/**
 * Add a service account and wait for the mirror to settle.
 *
 * @param {object} host - the booted host.
 * @param {string} name - the account name.
 * @param {string} email - the service account's address.
 * @returns {Promise<void>} nothing.
 */
async function addService(host, name, email) {
	const result = await call(host.routes, 'accounts/add-service', { name, keyJson: serviceKey(email) });
	assert.equal(result.ok, true, JSON.stringify(result.error));
	await new Promise((resolve) => setTimeout(resolve, 60));
}

await run.test('every service account gets its own 0600 key copy', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	await addService(host, 'one', 'one@example.iam.gserviceaccount.com');
	assert.ok(existsSync(file.key('one')), 'no private key copy');
	const mode = statSync(file.key('one')).mode & 0o777;
	assert.equal(mode, 0o600, `the key copy is ${mode.toString(8)}, not 0600`);
	const dir = statSync(file.own + '/keys').mode & 0o777;
	assert.equal(dir, 0o700, `the key directory is ${dir.toString(8)}, not 0700`);
});

await run.test('the mirror points at a separate copy, never at the key itself', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	await addService(host, 'one', 'one@example.iam.gserviceaccount.com');
	assert.ok(existsSync(file.mirrorKey('one')), 'the mirror has no copy of its own');
	const key = statSync(file.key('one'));
	const mirror = statSync(file.mirrorKey('one'));
	assert.notEqual(key.ino, mirror.ino, 'the mirror points at the authoritative key file');
	assert.equal(mirror.mode & 0o777, 0o600, 'the mirror copy is not 0600');
});

await run.test('the plugin never writes into <storeDir>/tokens or <storeDir>/credentials', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	await addService(host, 'one', 'one@example.iam.gserviceaccount.com');
	await call(host.routes, 'accounts/update', { name: 'one', subject: 'user@example.com' });
	await call(host.routes, 'accounts/update', { name: 'one', newName: 'two' });
	await call(host.routes, 'accounts/remove', { name: 'two' });
	for (const directory of ['tokens', 'credentials']) {
		const path = `${host.storeDir}/${directory}`;
		assert.ok(!existsSync(path), `${path} exists`);
	}
	// The plugin's own files live one directory deeper.
	assert.ok(existsSync(file.own), 'the plugin has no directory of its own');
});

await run.test('removing an account never unlinks a file another account points at', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	await addService(host, 'one', 'one@example.iam.gserviceaccount.com');
	// The shared file points at the private key of "one", the way the
	// upstream server's entry would.
	await writeShared(host.storeDir, {
		other: { name: 'other', kind: 'service_account', tokenPath: file.key('one') },
	});
	await call(host.routes, 'accounts/remove', { name: 'one' });
	assert.ok(existsSync(file.key('one')), 'the key file another account points at was deleted');
});

await run.test('an account the upstream server owns is read-only here', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	const upstream = `${host.storeDir}/upstream-key.json`;
	await writeFile(upstream, serviceKey('foreign@example.iam.gserviceaccount.com', 'UP'));
	await writeShared(host.storeDir, {
		foreign: { name: 'foreign', kind: 'service_account', tokenPath: upstream },
	});
	await new Promise((resolve) => setTimeout(resolve, 60));

	const updated = await call(host.routes, 'accounts/update', { name: 'foreign', newName: 'mine' });
	assert.equal(updated.ok, false, 'a foreign account was renamed');
	assert.match(updated.error.message, /Google Workspace MCP server/);

	const removed = await call(host.routes, 'accounts/remove', { name: 'foreign' });
	assert.equal(removed.ok, true, JSON.stringify(removed.error));
	assert.equal(removed.value.unlinked, true, 'the foreign account was not unlinked');
	const hidden = JSON.parse(await readFile(file.hidden, 'utf8'));
	assert.deepEqual(hidden.accounts, ['foreign'], 'the account was not hidden');
	assert.ok(existsSync(upstream), 'the upstream key file was deleted');
});

await run.test('the agent tools are exactly the five that read', async () => {
	const host = await boot();
	const names = host.tools.map((tool) => tool.name).sort();
	assert.deepEqual(names, [...AGENT_TOOLS].sort(), 'the agent tools changed');
	for (const tool of host.tools) {
		const schema = JSON.stringify(tool.parameters ?? {});
		for (const forbidden of ['newName', 'subject', 'keyJson', 'clientId', 'clientSecret']) {
			assert.ok(!schema.includes(forbidden), `the tool ${tool.name} takes ${forbidden}`);
		}
	}
});

await run.test('every registration happens inside ctx.effect', async () => {
	const host = await boot();
	// The fake context counts what was registered; the plugin must have
	// registered it through an effect, which the fake records.
	assert.ok(host.routes.size > 0, 'no routes were registered');
	assert.equal(host.tools.length, AGENT_TOOLS.length, 'the number of agent tools changed');
	for (const disposer of host.disposers) {
		assert.equal(typeof disposer, 'function', 'an effect did not return a disposer');
	}
});

await run.test('the plugin changes nothing outside itself', async () => {
	const { readdir, readFile: read } = await import('node:fs/promises');
	const { execFileSync } = await import('node:child_process');
	const patch = await read(`${process.cwd()}/cordis.patch.yml`, 'utf8');
	assert.ok(!/dsh-core|\/dsh\/|app\.asar/.test(patch), 'the bundle patch reaches outside the plugin');
	const entries = await readdir(process.cwd());
	assert.ok(!entries.includes('dsh'), 'the plugin ships a copy of the core');
	void execFileSync;
});

process.exit(run.report() === 0 ? 0 : 1);
