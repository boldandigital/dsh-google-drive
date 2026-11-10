/**
 * The built-in OAuth client — the host half.
 *
 * The plugin may ship an OAuth client of its own. When it does, a user signs
 * in with one click instead of building a client in the Cloud console first.
 * This script drives the plugin through its real RPC routes (the same path
 * the browser half uses) and checks that:
 *
 *   1. without a built-in client, a sign-in without a client id is refused
 *      with the message it always used;
 *   2. with a built-in client, the same sign-in starts a flow that uses it;
 *   3. a client the user brings is used instead of the built-in one;
 *   4. `useStored: true` still uses the client stored with the account;
 *   5. `onboarding/detect` reports `builtinClient.available`, and every field
 *      it reported before is still there;
 *   6. the plugin still boots with an empty config.
 *
 * The machine is made harmless first: HOME points at a temp directory, so no
 * real account file is read or written, and `gcloud` is put out of reach, so
 * the onboarding probe answers from the temp home alone.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { apply } = await import(`${PLUGIN}/lib/index.js`);
const { resolveOptions } = await import(`${PLUGIN}/lib/host/options.js`);
const { GoogleDriveService } = await import(`${PLUGIN}/lib/host/service.js`);
const { RPC_ENDPOINTS } = await import(`${PLUGIN}/lib/host/rpc.js`);

/** The OAuth client the plugin would ship. */
const BUILTIN_ID = '111111111111-builtin.apps.googleusercontent.com';
const BUILTIN_SECRET = 'GOCSPX-builtin-secret-value';

/** The client a user brings along. */
const USER_ID = '222222222222-user.apps.googleusercontent.com';
const USER_SECRET = 'GOCSPX-user-secret-value';

/** The client an account was created with. */
const STORED_ID = '333333333333-stored.apps.googleusercontent.com';
const STORED_SECRET = 'GOCSPX-stored-secret-value';

const home = await mkdtemp(path.join(os.tmpdir(), 'gd-builtin-home-'));
process.env.HOME = home;
delete process.env.GCLOUD;
process.env.PATH = '/usr/bin:/bin';

let passed = 0;
const failures = [];

/**
 * Run one check and report it.
 *
 * @param {string} name - what the check is called.
 * @param {() => Promise<void>} body - the check.
 */
async function test(name, body) {
	try {
		await body();
		passed += 1;
		console.log(`  ok    ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`  FAIL  ${name}`);
		console.log(`        ${error?.stack ?? String(error)}`);
	}
}

/**
 * A fake plugin context: it collects the routes and the tools the plugin
 * registers, so the test can call the RPC endpoints the way the browser does.
 *
 * @returns {{ctx: object, routes: Map<string, Function>, tools: object[], disposers: Function[]}} the host.
 */
function createCtx() {
	const routes = new Map();
	const tools = [];
	const disposers = [];
	const ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		on() {},
		effect(fn) {
			const disposer = fn();
			if (typeof disposer === 'function') disposers.push(disposer);
			return disposer;
		},
		tools: {
			register(tool) {
				tools.push(tool);
				return () => {
					const index = tools.indexOf(tool);
					if (index >= 0) tools.splice(index, 1);
				};
			},
		},
		connection: {
			fetch: {
				register(route) {
					routes.set(route.path, route.fetch);
					return () => routes.delete(route.path);
				},
			},
		},
	};
	return { ctx, routes, tools, disposers };
}

/**
 * Boot the plugin with a config.
 *
 * @param {object} [config] - the raw plugin config.
 * @returns {Promise<{ctx: object, routes: Map<string, Function>, tools: object[], disposers: Function[], storeDir: string}>} the host.
 */
async function boot(config = {}) {
	const storeDir = await mkdtemp(path.join(os.tmpdir(), 'gd-builtin-store-'));
	const host = createCtx();
	apply(host.ctx, { storeDir, mcpBridge: false, ...config });
	return { ...host, storeDir };
}

/**
 * Call one RPC endpoint the way the browser half calls it.
 *
 * @param {{routes: Map<string, Function>}} host - the booted plugin.
 * @param {string} endpoint - the endpoint name.
 * @param {object} [payload] - the request payload.
 * @returns {Promise<{ok: boolean, value?: object, error?: object}>} the result envelope.
 */
async function call(host, endpoint, payload = {}) {
	const route = `/api/google-drive/${endpoint}`;
	const handler = host.routes.get(route);
	assert.ok(handler, `no route is registered for ${endpoint}`);
	const request = new Request(`http://localhost${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			type: 'client-request',
			method: `google-drive/${endpoint}`,
			rpcId: 'test',
			payload,
		}),
	});
	const response = await handler(request);
	const message = await response.json();
	return message.result;
}

/**
 * The client id a sign-in URL carries.
 *
 * @param {string} authUrl - the URL the flow handed out.
 * @returns {string} the client id.
 */
function clientIdOf(authUrl) {
	return new URL(authUrl).searchParams.get('client_id') ?? '';
}

/**
 * Write an account that already has an OAuth client, the way a sign-in that
 * finished would have left it.
 *
 * @param {string} storeDir - the plugin's store directory.
 * @param {string} name - the account name.
 */
async function writeStoredAccount(storeDir, name) {
	const privateDir = path.join(storeDir, 'dsh-google-drive');
	await mkdir(path.join(privateDir, 'meta'), { recursive: true });
	await mkdir(path.join(privateDir, 'tokens'), { recursive: true });
	await writeFile(
		path.join(privateDir, 'meta', `${name}.json`),
		JSON.stringify({
			name,
			email: 'stored@example.com',
			type: 'oauth',
			subject: null,
			addedAt: new Date().toISOString(),
			scopes: ['https://www.googleapis.com/auth/drive'],
		}),
	);
	await writeFile(
		path.join(privateDir, 'tokens', `${name}.json`),
		JSON.stringify({
			type: 'authorized_user',
			client_id: STORED_ID,
			client_secret: STORED_SECRET,
			refresh_token: 'refresh-token-value',
		}),
	);
}

/**
 * Every file under a directory, with what it holds.
 *
 * @param {string} directory - the directory to walk.
 * @returns {Promise<string>} the contents of every file, joined.
 */
async function readTree(directory) {
	const parts = [];
	const walk = async (current) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const target = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(target);
				continue;
			}
			parts.push(await readFile(target, 'utf8').catch(() => ''));
		}
	};
	await walk(directory);
	return parts.join('\n');
}

console.log('gd-builtin-host-test');

await test('a sign-in without a client id is still refused when the plugin ships no client', async () => {
	const host = await boot();
	try {
		const result = await call(host, 'oauth/start', { name: 'personal' });
		assert.equal(result.ok, false, 'the sign-in must be refused');
		assert.equal(result.error.code, 'invalid-key');
		assert.equal(result.error.message, 'An OAuth client id is required.');
		assert.equal(result.error.details.field, 'clientId');
	} finally {
		for (const disposer of host.disposers) disposer();
	}
});

await test('a sign-in without a client id starts a flow with the built-in client', async () => {
	const host = await boot({ oauthClientId: BUILTIN_ID, oauthClientSecret: BUILTIN_SECRET });
	try {
		const result = await call(host, 'oauth/start', { name: 'personal' });
		assert.equal(result.ok, true, `the sign-in must start: ${JSON.stringify(result.error ?? {})}`);
		assert.equal(typeof result.value.flowId, 'string');
		assert.ok(result.value.flowId.length > 0, 'the flow must have an id');
		assert.equal(clientIdOf(result.value.authUrl), BUILTIN_ID, 'the URL must carry the built-in client id');
		assert.ok(
			!result.value.authUrl.includes(BUILTIN_SECRET),
			'the client secret must never travel in the sign-in URL',
		);
		const status = await call(host, 'oauth/status', { flowId: result.value.flowId });
		assert.equal(status.ok, true);
		assert.equal(status.value.status, 'pending', 'the flow must exist and be open');
	} finally {
		for (const disposer of host.disposers) disposer();
	}
});

await test('a client the user brings wins over the built-in one', async () => {
	const host = await boot({ oauthClientId: BUILTIN_ID, oauthClientSecret: BUILTIN_SECRET });
	try {
		const result = await call(host, 'oauth/start', {
			name: 'own-client',
			clientId: USER_ID,
			clientSecret: USER_SECRET,
		});
		assert.equal(result.ok, true, `the sign-in must start: ${JSON.stringify(result.error ?? {})}`);
		assert.equal(clientIdOf(result.value.authUrl), USER_ID, "the user's own client must be used");
	} finally {
		for (const disposer of host.disposers) disposer();
	}
});

await test('useStored: true keeps using the client stored with the account', async () => {
	const host = await boot({ oauthClientId: BUILTIN_ID, oauthClientSecret: BUILTIN_SECRET });
	try {
		await writeStoredAccount(host.storeDir, 'stored');
		const result = await call(host, 'oauth/start', { name: 'stored', useStored: true });
		assert.equal(result.ok, true, `the sign-in must start: ${JSON.stringify(result.error ?? {})}`);
		assert.equal(
			clientIdOf(result.value.authUrl),
			STORED_ID,
			'the client stored with the account must be used, not the built-in one',
		);
	} finally {
		for (const disposer of host.disposers) disposer();
	}
});

await test('onboarding/detect reports the built-in client, and keeps every field it had', async () => {
	const withClient = await boot({ oauthClientId: BUILTIN_ID, oauthClientSecret: BUILTIN_SECRET });
	try {
		const result = await call(withClient, 'onboarding/detect', {});
		assert.equal(result.ok, true);
		const payload = result.value;
		assert.ok(payload.builtinClient, 'the payload must carry builtinClient');
		assert.equal(payload.builtinClient.available, true, 'a configured client must be reported');
		for (const field of ['gcloud', 'oauthClients', 'serviceAccounts']) {
			assert.ok(field in payload, `the payload must still carry ${field}`);
		}
		assert.ok('path' in payload.gcloud, 'the gcloud object must still carry its fields');
		assert.ok(Array.isArray(payload.oauthClients), 'oauthClients must still be a list');
		assert.ok(Array.isArray(payload.serviceAccounts), 'serviceAccounts must still be a list');
		assert.ok(
			!JSON.stringify(payload).includes(BUILTIN_SECRET),
			'the client secret must never travel to the browser',
		);
	} finally {
		for (const disposer of withClient.disposers) disposer();
	}

	const withoutClient = await boot();
	try {
		const result = await call(withoutClient, 'onboarding/detect', {});
		assert.equal(result.ok, true);
		assert.ok(result.value.builtinClient, 'the payload must carry builtinClient');
		assert.equal(result.value.builtinClient.available, false, 'no client means not available');
		for (const field of ['gcloud', 'oauthClients', 'serviceAccounts']) {
			assert.ok(field in result.value, `the payload must still carry ${field}`);
		}
	} finally {
		for (const disposer of withoutClient.disposers) disposer();
	}
});

await test('the plugin boots with an empty config', async () => {
	const storeDir = await mkdtemp(path.join(os.tmpdir(), 'gd-builtin-empty-'));
	const host = createCtx();
	apply(host.ctx, { storeDir, mcpBridge: false });
	try {
		assert.equal(host.routes.size, RPC_ENDPOINTS.length, 'every endpoint must be registered');
		assert.equal(host.tools.length, 5, 'the five agent tools must stay exactly as they are');
		const result = await call(host, 'oauth/start', { name: 'personal' });
		assert.equal(result.ok, false, 'without a client the sign-in is still refused');
		assert.equal(result.error.message, 'An OAuth client id is required.');
	} finally {
		for (const disposer of host.disposers) disposer();
	}
});

await test('the built-in secret never reaches the disk or an account', async () => {
	const host = await boot({ oauthClientId: BUILTIN_ID, oauthClientSecret: BUILTIN_SECRET });
	try {
		const result = await call(host, 'oauth/start', { name: 'personal' });
		assert.equal(result.ok, true);
		const files = await readTree(host.storeDir);
		assert.ok(!files.includes(BUILTIN_SECRET), 'the client secret must not be written to the store');
		const listed = await call(host, 'accounts/list', {});
		assert.equal(listed.ok, true);
		assert.ok(
			!JSON.stringify(listed.value).includes(BUILTIN_SECRET),
			'the client secret must not travel in an account listing',
		);
	} finally {
		for (const disposer of host.disposers) disposer();
	}
});

await test('resolveOptions keeps the old fields and adds the two new ones', async () => {
	const empty = resolveOptions({});
	assert.equal(empty.oauthClientId, '');
	assert.equal(empty.oauthClientSecret, '');
	assert.deepEqual(empty.scopes, ['https://www.googleapis.com/auth/drive']);
	assert.equal(empty.defaultAccount, null);
	assert.equal(empty.mcpBridge, true);
	assert.equal(typeof empty.storeDir, 'string');

	const filled = resolveOptions({
		scopes: ['a'],
		defaultAccount: ' personal ',
		mcpBridge: false,
		storeDir: ' /tmp/gd-store ',
		oauthClientId: '  id  ',
		oauthClientSecret: '  secret  ',
	});
	assert.deepEqual(filled.scopes, ['a']);
	assert.equal(filled.defaultAccount, 'personal');
	assert.equal(filled.mcpBridge, false);
	assert.equal(filled.storeDir, path.resolve('/tmp/gd-store'));
	assert.equal(filled.oauthClientId, 'id');
	assert.equal(filled.oauthClientSecret, 'secret');
});

await test('the service says whether it ships a client', async () => {
	const host = createCtx();
	const withClient = new GoogleDriveService(host.ctx, resolveOptions({ oauthClientId: BUILTIN_ID }));
	const withoutClient = new GoogleDriveService(host.ctx, resolveOptions({}));
	assert.equal(withClient.hasBuiltinOauthClient(), true);
	assert.equal(withoutClient.hasBuiltinOauthClient(), false);
	assert.equal(withoutClient.builtinOauthClient(), null);
	assert.deepEqual(withClient.builtinOauthClient(), { clientId: BUILTIN_ID, clientSecret: '' });
	withClient.dispose();
	withoutClient.dispose();
});

await test('the ordinary account flows still work', async () => {
	const host = await boot();
	try {
		const key = {
			type: 'service_account',
			project_id: 'charged-garden-280823',
			private_key_id: 'key-1',
			// eslint-disable-next-line no-template-curly-in-string
			private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
			client_email: 'robot@charged-garden-280823.iam.gserviceaccount.com',
			client_id: '123456789',
		};
		const added = await call(host, 'accounts/add-service', { name: 'robot', keyJson: JSON.stringify(key) });
		assert.equal(added.ok, true, `the account must be added: ${JSON.stringify(added.error ?? {})}`);
		assert.equal(added.value.account.name, 'robot');
		assert.equal(added.value.account.type, 'service_account');

		const listed = await call(host, 'accounts/list', {});
		assert.equal(listed.ok, true);
		assert.equal(listed.value.accounts.length, 1);
		assert.equal(listed.value.accounts[0].name, 'robot');

		const renamed = await call(host, 'accounts/update', { name: 'robot', newName: 'robot-two' });
		assert.equal(renamed.ok, true, `the account must be renamed: ${JSON.stringify(renamed.error ?? {})}`);
		assert.equal(renamed.value.renamed, true);
		assert.equal(renamed.value.account.name, 'robot-two');

		const removed = await call(host, 'accounts/remove', { name: 'robot-two' });
		assert.equal(removed.ok, true, `the account must be removed: ${JSON.stringify(removed.error ?? {})}`);
		assert.equal(removed.value.removed, true);

		const after = await call(host, 'accounts/list', {});
		assert.equal(after.value.accounts.length, 0);
	} finally {
		for (const disposer of host.disposers) disposer();
	}
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`- ${failure.name}`);
	process.exitCode = 1;
}
