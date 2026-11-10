/**
 * The shared harness for the plugin's tests.
 *
 * The tests live in the repository rather than in a temporary directory, so
 * they survive a restart and can be run by anyone who checks the plugin out.
 * They drive the plugin through its real RPC routes — the same path the
 * browser half uses — and through the host service directly, so what they
 * check is what the plugin does and not what it says about itself.
 *
 * Nothing here touches the real machine: HOME points at a temporary
 * directory, the store is a temporary directory, and `gcloud` is put out of
 * reach so the onboarding probe answers from the temporary home alone.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of the plugin, so the tests work whatever directory they run in. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { apply } = await import(`${ROOT}/lib/index.js`);
const { rpcMethod, rpcRoutePath } = await import(`${ROOT}/lib/host/rpc.js`);

/**
 * A fake plugin context.
 *
 * It collects the routes and the tools the plugin registers, so a test can
 * call an endpoint the way the browser does and can count the agent tools.
 *
 * @returns {object} the context, the collected routes, tools and disposers.
 */
export function createCtx() {
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
 * Boot the plugin with a config, against a temporary store.
 *
 * @param {object} [config] - the raw plugin config.
 * @param {object} [options] - `{ withCredentials }`.
 * @returns {Promise<object>} the host, its routes, tools and the store path.
 */
export async function boot(config = {}, options = {}) {
	const storeDir = await mkdtemp(path.join(os.tmpdir(), 'gd-store-'));
	const host = createCtx();
	const records = new Map();
	if (options.withCredentials !== false) {
		host.ctx.credentials = {
			async modifyRecord(key, mutate) {
				const next = await mutate(records.get(key));
				if (next === undefined) return records.get(key);
				records.set(key, next);
				return next;
			},
			async readRecord(key) {
				return records.get(key);
			},
			async deleteRecord(key) {
				records.delete(key);
			},
			async listRecords() {
				return [...records.keys()].map((key) => ({ key, kind: 'grant' }));
			},
		};
	}
	apply(host.ctx, { storeDir, ...config });
	return { ...host, storeDir, records };
}

/**
 * Call one endpoint the way the browser half calls it.
 *
 * @param {Map<string, Function>} routes - the registered routes.
 * @param {string} endpoint - the endpoint name, e.g. `accounts/list`.
 * @param {object} payload - the request payload.
 * @returns {Promise<object>} the result envelope: `{ ok, value }` or `{ ok, error }`.
 */
export async function call(routes, endpoint, payload = {}) {
	const route = routes.get(rpcRoutePath(endpoint));
	if (!route) throw new Error(`no route for ${endpoint}`);
	const request = new Request(`http://localhost${rpcRoutePath(endpoint)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			type: 'client-request',
			rpcId: 'test',
			method: rpcMethod(endpoint),
			payload,
		}),
	});
	const response = await route(request);
	const body = await response.json();
	return body.result;
}

/**
 * A service-account key, as a user would paste it.
 *
 * The private key is a placeholder: nothing ever signs a JWT with it in the
 * tests, and no request leaves the machine.
 *
 * @param {string} email - the address of the service account.
 * @param {string} [marker] - a marker so two keys can be told apart.
 * @returns {string} the key, as JSON.
 */
export function serviceKey(email, marker = 'AA') {
	return JSON.stringify({
		type: 'service_account',
		project_id: 'test-project',
		private_key_id: 'test-key-id',
		private_key: `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\n`,
		client_email: email,
		client_id: '1234567890',
		auth_uri: 'https://accounts.google.com/o/oauth2/auth',
		token_uri: 'https://oauth2.googleapis.com/token',
	});
}

/**
 * The paths the plugin keeps its own files in.
 *
 * @param {string} storeDir - the store directory.
 * @returns {object} the paths, by kind.
 */
export function paths(storeDir) {
	const own = path.join(storeDir, 'dsh-google-drive');
	return {
		own,
		meta: (name) => path.join(own, 'meta', `${name}.json`),
		key: (name) => path.join(own, 'keys', `${name}.json`),
		mirrorKey: (name) => path.join(own, 'mirror-keys', `${name}.json`),
		token: (name) => path.join(own, 'tokens', `${name}.json`),
		credential: (name) => path.join(own, 'credentials', `${name}.json`),
		hidden: path.join(own, 'hidden.json'),
		shared: path.join(storeDir, 'accounts.json'),
	};
}

/**
 * Write an account into the shared file the upstream MCP server reads.
 *
 * @param {string} storeDir - the store directory.
 * @param {object} accounts - the accounts, by name.
 * @returns {Promise<void>} nothing.
 */
export async function writeShared(storeDir, accounts) {
	await writeFile(path.join(storeDir, 'accounts.json'), JSON.stringify({ accounts }, null, 2));
	await mkdir(path.join(storeDir, 'dsh-google-drive', 'mirror-keys'), { recursive: true });
}

/**
 * A tiny test runner.
 *
 * @param {string} title - the name of the suite.
 * @returns {{test: Function, report: Function}} the runner and its report.
 */
export function suite(title) {
	let passed = 0;
	const failures = [];
	console.log(`\n== ${title} ==`);
	return {
		async test(name, body) {
			try {
				await body();
				passed += 1;
				console.log(`  ok    ${name}`);
			} catch (error) {
				failures.push({ name, error });
				console.log(`  FAIL  ${name}`);
				console.log(`        ${error?.stack ?? String(error)}`);
			}
		},
		report() {
			console.log(`\n${passed} passed, ${failures.length} failed`);
			return failures.length;
		},
	};
}
