/**
 * The OAuth sign-in flow.
 *
 * A loopback server on an ephemeral port receives Google's redirect, exactly
 * as a desktop OAuth client does: the plugin never opens a browser, it hands
 * the user a URL and waits. The flow is short lived (five minutes), can be
 * cancelled, and its server is always closed — on success, on failure, on
 * timeout and when the plugin unloads.
 *
 * Only a few sign-ins may be open at once, because each one holds a
 * listening socket, and a sweep runs on its own so a sign-in nobody
 * finishes is closed and swept away on time. A flow that ends keeps nothing
 * but the reason it ended: the client secret, the PKCE verifier and the
 * state are dropped as soon as the flow is over.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { invalidInput } from './errors.js';
import { GOOGLE_AUTH_URL } from './google-api.js';

/** How long a sign-in stays open. */
export const OAUTH_FLOW_TTL_MS = 5 * 60 * 1000;

/** How many sign-ins may be open at the same time. */
export const MAX_OPEN_FLOWS = 8;

/** How often the manager sweeps the flows it no longer needs. */
const PRUNE_INTERVAL_MS = 30000;

/** How many finished flows are remembered, so a late status call still explains itself. */
const HISTORY_LIMIT = 64;

/** The path the redirect URI points at. */
export const OAUTH_CALLBACK_PATH = '/oauth/google/callback';

/**
 * Write one plain answer to the browser that ran the redirect.
 *
 * @param {import('node:http').ServerResponse} response - the response to write.
 * @param {number} status - the HTTP status.
 * @param {string} message - the text to show.
 */
function respond(response, status, message) {
	response.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
	});
	response.end(message);
}

/**
 * Manage the open OAuth flows.
 */
export class OAuthFlowManager {
	/**
	 * @param {object} options - the manager dependencies.
	 * @param {(flow: object, code: string) => Promise<object>} options.onComplete - finishes a flow.
	 * @param {() => number} [options.now] - the clock, for tests.
	 */
	constructor({ onComplete, now = () => Date.now() }) {
		this.flows = new Map();
		this.expired = new Map();
		this.onComplete = onComplete;
		this.now = now;
		// The sweep runs on its own, so a sign-in nobody finishes is swept
		// away on time instead of waiting for the next flow to complete.
		this.sweeper = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
		this.sweeper.unref?.();
	}

	/**
	 * Close one flow's server and clear its timer.
	 *
	 * @param {object} flow - the flow to close.
	 */
	close(flow) {
		if (!flow) return;
		if (flow.timer) {
			clearTimeout(flow.timer);
			flow.timer = null;
		}
		try {
			flow.server.close();
			flow.server.closeAllConnections?.();
		} catch {
			// The server is already closed; nothing to release.
		}
	}

	/**
	 * Start one sign-in flow.
	 *
	 * The redirect URI says `localhost` while the socket listens on
	 * `127.0.0.1`: Google accepts either loopback spelling for a desktop
	 * client, and `localhost` is the spelling its own documentation uses.
	 *
	 * @param {object} options - the flow inputs.
	 * @param {string} options.name - the account name the sign-in belongs to.
	 * @param {string} options.clientId - the OAuth client id.
	 * @param {string} options.clientSecret - the OAuth client secret.
	 * @param {string[]} options.scopes - the scopes to request.
	 * @param {boolean} [options.replace] - whether this flow renews an account that already exists.
	 * @returns {Promise<{flowId: string, authUrl: string, expiresAt: number}>} the flow handle.
	 */
	async start({ name, clientId, clientSecret, scopes, replace = false }) {
		// Every open flow holds a listening socket for as long as it lives,
		// so a caller cannot pile them up. The check runs before the socket
		// is opened, so a refused sign-in leaves nothing behind.
		const open = [...this.flows.values()].filter(
			(flow) => flow.status === 'pending' || flow.status === 'processing',
		);
		if (open.length >= MAX_OPEN_FLOWS) {
			throw invalidInput(
				`${MAX_OPEN_FLOWS} sign-ins are already open. Finish or cancel one of them before starting another.`,
				{ field: 'flow' },
			);
		}
		const flowId = randomBytes(16).toString('hex');
		const state = randomBytes(32).toString('base64url');
		const verifier = randomBytes(32).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const server = createServer((request, response) => {
			void this.handle(flowId, request, response);
		});
		await new Promise((resolve, reject) => {
			const onError = (error) => reject(error);
			server.once('error', onError);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', onError);
				resolve();
			});
		});
		server.on('error', () => {
			// A late socket error must not take the plugin down.
		});
		server.unref();
		const address = server.address();
		if (!address || typeof address === 'string') {
			server.close();
			throw new Error('The local sign-in callback could not be started.');
		}
		const redirectUri = `http://localhost:${address.port}${OAUTH_CALLBACK_PATH}`;
		const url = new URL(GOOGLE_AUTH_URL);
		for (const [key, value] of Object.entries({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: scopes.join(' '),
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			access_type: 'offline',
			prompt: 'consent',
		})) {
			url.searchParams.set(key, value);
		}
		const flow = {
			id: flowId,
			name,
			clientId,
			clientSecret,
			scopes: [...scopes],
			replace,
			state,
			verifier,
			redirectUri,
			server,
			timer: null,
			status: 'pending',
			message: null,
			account: null,
			expiresAt: this.now() + OAUTH_FLOW_TTL_MS,
		};
		flow.timer = setTimeout(() => {
			this.expire(flow);
		}, OAUTH_FLOW_TTL_MS);
		flow.timer.unref?.();
		this.flows.set(flowId, flow);
		return { flowId, authUrl: url.href, expiresAt: flow.expiresAt };
	}

	/**
	 * Handle the browser's redirect back to the loopback server.
	 *
	 * @param {string} flowId - the flow the callback belongs to.
	 * @param {import('node:http').IncomingMessage} request - the request.
	 * @param {import('node:http').ServerResponse} response - the response.
	 */
	async handle(flowId, request, response) {
		const flow = this.flows.get(flowId);
		if (!flow || request.method !== 'GET') {
			respond(response, 400, 'This sign-in link is not valid any more.');
			return;
		}
		let url;
		try {
			url = new URL(request.url ?? '', flow.redirectUri);
		} catch {
			respond(response, 400, 'This sign-in link is not valid any more.');
			return;
		}
		const supplied = url.searchParams.get('state') ?? '';
		const sameState =
			url.searchParams.getAll('state').length === 1 &&
			Buffer.byteLength(supplied) === Buffer.byteLength(flow.state) &&
			timingSafeEqual(Buffer.from(supplied), Buffer.from(flow.state));
		if (!sameState) {
			respond(response, 403, 'The sign-in link did not match this request. Start the sign-in again.');
			return;
		}
		if (flow.status !== 'pending') {
			respond(response, 409, 'This sign-in was already used or has expired.');
			return;
		}
		if (url.searchParams.has('error')) {
			flow.status = 'failed';
			flow.message = `Google did not grant access: ${url.searchParams.get('error') ?? 'unknown error'}.`;
			respond(response, 400, flow.message);
			this.close(flow);
			return;
		}
		const code = url.searchParams.get('code');
		if (!code || url.searchParams.getAll('code').length !== 1) {
			respond(response, 400, 'Google did not return an authorization code.');
			return;
		}
		flow.status = 'processing';
		try {
			const account = await this.onComplete(flow, code);
			flow.status = 'authorized';
			flow.account = account;
			respond(response, 200, `Signed in as ${account?.email ?? flow.name}. You can close this tab and return to DSH.`);
		} catch (error) {
			flow.status = 'failed';
			flow.message = error instanceof Error ? error.message : String(error);
			respond(response, 400, flow.message);
		} finally {
			// The verifier is a one-time secret; it is dropped as soon as the
			// exchange is over, whatever the outcome was.
			flow.verifier = '';
			flow.state = '';
			flow.clientSecret = '';
			this.close(flow);
			this.prune();
		}
	}

	/**
	 * Give up on one flow: close it, drop its secrets and forget it.
	 *
	 * An abandoned sign-in must not keep the client secret, the PKCE verifier
	 * or the state in memory for the rest of the session. Only the reason is
	 * kept, so a status call that arrives after the flow is gone still tells
	 * the user what happened.
	 *
	 * @param {object} flow - the flow to expire.
	 */
	expire(flow) {
		if (!flow) return;
		flow.status = 'failed';
		flow.message = 'The sign-in was not completed within five minutes. Start it again.';
		flow.verifier = '';
		flow.state = '';
		flow.clientSecret = '';
		this.close(flow);
		this.flows.delete(flow.id);
		this.remember(flow.id, flow.message);
	}

	/**
	 * Remember why a flow ended, for a status call that arrives too late.
	 *
	 * @param {string} flowId - the flow id.
	 * @param {string} message - why the flow ended.
	 */
	remember(flowId, message) {
		this.expired.delete(flowId);
		this.expired.set(flowId, message);
		while (this.expired.size > HISTORY_LIMIT) {
			const oldest = this.expired.keys().next();
			if (oldest.done) break;
			this.expired.delete(oldest.value);
		}
	}

	/**
	 * Drop the flows that are finished and keep the map bounded.
	 *
	 * A flow past its expiry is finished whether or not its timer fired, so
	 * the sweep closes it and takes its secrets with it. A finished flow is
	 * kept for a while so the client can still read why a sign-in failed,
	 * but the map must not grow without bound.
	 */
	prune() {
		const now = this.now();
		for (const flow of [...this.flows.values()]) {
			if (flow.status !== 'pending' && flow.status !== 'processing') continue;
			if (flow.expiresAt <= now) this.expire(flow);
		}
		const limit = HISTORY_LIMIT;
		if (this.flows.size <= limit) return;
		for (const flow of this.flows.values()) {
			if (this.flows.size <= limit) break;
			if (flow.status === 'pending' || flow.status === 'processing') continue;
			this.flows.delete(flow.id);
		}
	}

	/**
	 * Report the state of one flow.
	 *
	 * @param {string} flowId - the flow to report.
	 * @returns {{status: string, message: string|null, account: object|null}} the state.
	 */
	status(flowId) {
		const flow = this.flows.get(flowId);
		if (!flow) {
			const expired = this.expired.get(flowId);
			if (expired) return { status: 'failed', message: expired, account: null };
			return { status: 'failed', message: 'This sign-in is unknown; start it again.', account: null };
		}
		if (flow.status === 'authorized') return { status: 'authorized', message: null, account: flow.account };
		if (flow.status === 'failed') return { status: 'failed', message: flow.message ?? 'The sign-in failed.', account: null };
		return { status: 'pending', message: null, account: null };
	}

	/**
	 * Cancel one flow and close its server.
	 *
	 * @param {string} flowId - the flow to cancel.
	 * @returns {boolean} true when a flow was cancelled.
	 */
	cancel(flowId) {
		const flow = this.flows.get(flowId);
		if (!flow) return false;
		flow.status = 'failed';
		flow.message = 'The sign-in was cancelled.';
		flow.verifier = '';
		flow.state = '';
		flow.clientSecret = '';
		this.close(flow);
		this.flows.delete(flowId);
		return true;
	}

	/** Cancel every open flow; called when the plugin unloads. */
	dispose() {
		clearInterval(this.sweeper);
		this.sweeper = null;
		for (const flowId of [...this.flows.keys()]) this.cancel(flowId);
		this.flows.clear();
		this.expired.clear();
	}
}
