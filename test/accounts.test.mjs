/**
 * Changing an account: renaming it, re-keying it, renewing it, and taking
 * an account the upstream server owns into this plugin.
 *
 * Every check here is about what must NOT happen as much as about what
 * must: a refused change may not leave anything behind, and an account the
 * upstream server owns may not be taken over behind its back.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { boot, call, paths, serviceKey, suite, writeShared } from './harness.mjs';

const run = suite('Changing an account');

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

/**
 * A shared file holding one account the upstream server owns.
 *
 * @param {object} host - the booted host.
 * @param {string} [marker] - a marker so the key can be told apart.
 * @returns {Promise<string>} the path of the upstream key file.
 */
async function withForeign(host, marker = 'UP') {
	const upstream = `${host.storeDir}/upstream-key.json`;
	await writeFile(upstream, serviceKey('foreign@example.iam.gserviceaccount.com', marker));
	await writeShared(host.storeDir, {
		foreign: {
			name: 'foreign',
			email: 'foreign@example.iam.gserviceaccount.com',
			kind: 'service_account',
			tokenPath: upstream,
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 60));
	return upstream;
}

await run.test('a refused rename leaves the key, the metadata and the record untouched', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	await addService(host, 'one', 'one@example.iam.gserviceaccount.com');
	await addService(host, 'two', 'two@example.iam.gserviceaccount.com');
	const before = await readFile(file.key('one'), 'utf8');
	const metaBefore = await readFile(file.meta('one'), 'utf8');

	const result = await call(host.routes, 'accounts/update', {
		name: 'one',
		newName: 'two',
		keyJson: serviceKey('other@example.iam.gserviceaccount.com', 'ZZ'),
	});
	assert.equal(result.ok, false, 'the rename onto a taken name was allowed');
	assert.match(result.error.message, /already exists/);
	assert.equal(await readFile(file.key('one'), 'utf8'), before, 'the key file changed although the edit was refused');
	assert.equal(await readFile(file.meta('one'), 'utf8'), metaBefore, 'the metadata changed although the edit was refused');
});

await run.test('renaming onto a name the upstream server holds is refused', async () => {
	const host = await boot();
	const upstream = await withForeign(host);
	await addService(host, 'mine', 'mine@example.iam.gserviceaccount.com');
	const result = await call(host.routes, 'accounts/update', { name: 'mine', newName: 'foreign' });
	assert.equal(result.ok, false, 'the rename took over an upstream account');
	assert.match(result.error.message, /Google Workspace MCP server/);
	const shared = JSON.parse(await readFile(`${host.storeDir}/accounts.json`, 'utf8'));
	assert.equal(shared.accounts.foreign.tokenPath, upstream, 'the upstream entry was overwritten');
});

await run.test('renaming keeps a key file another account still points at', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	await addService(host, 'one', 'one@example.iam.gserviceaccount.com');
	await writeShared(host.storeDir, {
		other: { name: 'other', kind: 'service_account', tokenPath: file.key('one') },
	});
	await new Promise((resolve) => setTimeout(resolve, 60));
	const result = await call(host.routes, 'accounts/update', { name: 'one', newName: 'two' });
	assert.equal(result.ok, true, JSON.stringify(result.error));
	assert.ok(existsSync(file.key('one')), 'the key file another account points at was deleted');
});

await run.test('a name that differs only in letter case is refused with a message that says so', async () => {
	const host = await boot();
	await addService(host, 'one', 'one@example.iam.gserviceaccount.com');
	const result = await call(host.routes, 'accounts/update', { name: 'one', newName: 'One' });
	assert.equal(result.ok, false, 'a case-only rename was allowed');
	assert.ok(
		!/already exists/.test(result.error.message),
		`the message blames an account that does not exist: ${result.error.message}`,
	);
});

await run.test('signing in again with a different Google account is refused', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	const realFetch = globalThis.fetch;
	let signedInAs = 'one@example.com';
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes('oauth2.googleapis.com/token')) {
			return new Response(
				JSON.stringify({ access_token: 'access-' + signedInAs, refresh_token: 'refresh-' + signedInAs }),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}
		if (url.includes('openidconnect.googleapis.com')) {
			return new Response(JSON.stringify({ email: signedInAs }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		return realFetch(input);
	};
	try {
		/* The first sign-in creates the account. */
		const started = await call(host.routes, 'oauth/start', {
			name: 'google',
			clientId: 'client-id',
			clientSecret: 'client-secret',
		});
		assert.equal(started.ok, true, JSON.stringify(started.error));
		await finishSignIn(started.value.authUrl);

		const stored = JSON.parse(await readFile(file.meta('google'), 'utf8'));
		assert.equal(stored.email, 'one@example.com', 'the account was filed under the wrong address');
		const tokenBefore = await readFile(file.token('google'), 'utf8');

		/* Signing in again as somebody else must not rebind the account. */
		signedInAs = 'two@example.com';
		const again = await call(host.routes, 'oauth/start', { name: 'google', useStored: true });
		assert.equal(again.ok, true, JSON.stringify(again.error));
		await finishSignIn(again.value.authUrl);

		const after = JSON.parse(await readFile(file.meta('google'), 'utf8'));
		assert.equal(after.email, 'one@example.com', 'the account was rebound to another Google account');
		assert.equal(await readFile(file.token('google'), 'utf8'), tokenBefore, 'the stored token was overwritten');
	} finally {
		globalThis.fetch = realFetch;
	}
});


/**
 * Finish a sign-in the way the browser would.
 *
 * The host runs a loopback server and waits for Google to redirect back to
 * it; the test plays the part of Google and calls that address with a code.
 *
 * @param {string} authUrl - the authorisation URL the host handed out.
 * @returns {Promise<void>} nothing.
 */
async function finishSignIn(authUrl) {
	const authorisation = new URL(authUrl);
	const url = new URL(authorisation.searchParams.get('redirect_uri'));
	url.searchParams.set('code', 'test-code');
	/* The host checks the state it sent, the way a browser would. */
	url.searchParams.set('state', authorisation.searchParams.get('state'));
	await fetch(url.href).catch(() => null);
	await new Promise((resolve) => setTimeout(resolve, 120));
}

await run.test('taking an account over gives the plugin its own private copy', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	const upstream = await withForeign(host);
	const result = await call(host.routes, 'accounts/adopt', { name: 'foreign' });
	assert.equal(result.ok, true, JSON.stringify(result.error));
	assert.equal(result.value.account.name, 'foreign');
	assert.equal(result.value.account.email, 'foreign@example.iam.gserviceaccount.com');

	assert.ok(existsSync(file.key('foreign')), 'the plugin made no private copy');
	assert.notEqual(
		await readFile(file.key('foreign'), 'utf8'),
		await readFile(upstream, 'utf8'),
		'the plugin pointed at the upstream file instead of a copy',
	);
	assert.equal(await readFile(upstream, 'utf8'), serviceKey('foreign@example.iam.gserviceaccount.com', 'UP'), 'the upstream file changed');
});

await run.test('the shared file keeps the account and points at the copy', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	const upstream = await withForeign(host);
	await call(host.routes, 'accounts/adopt', { name: 'foreign' });
	await new Promise((resolve) => setTimeout(resolve, 60));
	const shared = JSON.parse(await readFile(`${host.storeDir}/accounts.json`, 'utf8'));
	assert.ok(shared.accounts.foreign, 'the account disappeared from the shared file');
	assert.equal(shared.accounts.foreign.tokenPath, file.mirrorKey('foreign'), 'the shared file does not point at the copy');
	assert.notEqual(shared.accounts.foreign.tokenPath, upstream, 'the shared file still points at the upstream file');
});

await run.test('a taken-over account is listed once, as an account of this plugin', async () => {
	const host = await boot();
	await withForeign(host);
	await call(host.routes, 'accounts/adopt', { name: 'foreign' });
	await new Promise((resolve) => setTimeout(resolve, 60));
	const list = await call(host.routes, 'accounts/list', {});
	const rows = list.value.accounts.filter((entry) => entry.name === 'foreign');
	assert.equal(rows.length, 1, `the account is listed ${rows.length} times`);
	assert.notEqual(rows[0].foreign, true, 'the account is still marked as belonging elsewhere');
});

await run.test('a taken-over account can be renamed', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	await withForeign(host);
	await call(host.routes, 'accounts/adopt', { name: 'foreign' });
	await new Promise((resolve) => setTimeout(resolve, 60));
	const renamed = await call(host.routes, 'accounts/update', { name: 'foreign', newName: 'mine' });
	assert.equal(renamed.ok, true, JSON.stringify(renamed.error));
	assert.equal(renamed.value.renamed, true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.ok(existsSync(file.key('mine')), 'the renamed account has no key');
	assert.ok(!existsSync(file.key('foreign')), 'the old key file was left behind');
});

await run.test('taking an account over twice is refused', async () => {
	const host = await boot();
	await withForeign(host);
	await call(host.routes, 'accounts/adopt', { name: 'foreign' });
	await new Promise((resolve) => setTimeout(resolve, 60));
	const again = await call(host.routes, 'accounts/adopt', { name: 'foreign' });
	assert.equal(again.ok, false, 'the account was taken over twice');
	assert.match(again.error.message, /already belongs to this plugin/);
});

await run.test('an account whose key file is gone cannot be taken over', async () => {
	const host = await boot();
	await writeShared(host.storeDir, {
		broken: { name: 'broken', kind: 'service_account', tokenPath: `${host.storeDir}/gone.json` },
	});
	await new Promise((resolve) => setTimeout(resolve, 60));
	const result = await call(host.routes, 'accounts/adopt', { name: 'broken' });
	assert.equal(result.ok, false, 'a broken account was taken over');
	assert.match(result.error.message, /cannot be read/);
});

await run.test('unlinking an account leaves the upstream server\'s entry alone', async () => {
	const host = await boot();
	const file = paths(host.storeDir);
	const upstreamKey = file.mirrorKey('linked');
	await writeShared(host.storeDir, {
		linked: { name: 'linked', kind: 'service_account', tokenPath: upstreamKey },
	});
	await new Promise((resolve) => setTimeout(resolve, 60));
	const removed = await call(host.routes, 'accounts/remove', { name: 'linked' });
	assert.equal(removed.ok, true, JSON.stringify(removed.error));
	assert.equal(removed.value.unlinked, true);
	// Now the plugin owns an account, so the shared file is written.
	await addService(host, 'mine', 'mine@example.iam.gserviceaccount.com');
	await new Promise((resolve) => setTimeout(resolve, 60));
	const shared = JSON.parse(await readFile(`${host.storeDir}/accounts.json`, 'utf8'));
	assert.ok(shared.accounts.linked, 'the unlinked account was deleted from the shared file');
	assert.equal(shared.accounts.linked.tokenPath, upstreamKey, 'the unlinked entry was rewritten');
});

process.exit(run.report() === 0 ? 0 : 1);
