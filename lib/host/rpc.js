/**
 * The RPC layer between the browser half and this host.
 *
 * The routes ride Connection's exact Fetch registry rather than
 * `connection.rpc.handle`: in DSH 0.1.5+ that channel's disposer resolves
 * `owner.webServer` against the Connection plugin's own fiber, which never
 * holds `webServer`, so a third-party channel throws inside a child fiber
 * and vanishes without a boot error.
 */

import { toErrorPayload } from './errors.js';

/** Connection's authenticated channel; the browser half calls into it. */
export const RPC_CHANNEL = '/api';

/** The method namespace this plugin owns under {@link RPC_CHANNEL}. */
export const RPC_METHOD_PREFIX = 'google-drive';

/** The endpoints the browser half may call. */
export const RPC_ENDPOINTS = [
	'accounts/list',
	'oauth/start',
	'oauth/status',
	'oauth/cancel',
	'accounts/add-service',
	'accounts/remove',
	'accounts/test',
	'settings/get',
	'settings/set',
	'onboarding/detect',
	'onboarding/create-service-key',
	'drive/list',
	'drive/search',
	'drive/download',
	'drive/upload',
	'drive/get-file',
];

/**
 * The method name the browser half sends for one endpoint.
 *
 * @param {string} endpoint - the endpoint name.
 * @returns {string} the fully qualified method.
 */
export function rpcMethod(endpoint) {
	return `${RPC_METHOD_PREFIX}/${endpoint}`;
}

/**
 * The exact Fetch route path Connection serves one endpoint on.
 *
 * @param {string} endpoint - the endpoint name.
 * @returns {string} the route path.
 */
export function rpcRoutePath(endpoint) {
	return `${RPC_CHANNEL}/${rpcMethod(endpoint)}`;
}

/**
 * Build one failure result.
 *
 * @param {string} code - the error code.
 * @param {string} message - the message the user sees.
 * @param {object} [details] - machine-readable context.
 * @returns {object} the failure result.
 */
export function rpcError(code, message, details = {}) {
	return { ok: false, error: { code, message, details: details ?? {} } };
}

/**
 * Wrap one result in the server-response envelope Connection expects.
 *
 * @param {string} rpcId - the caller's correlation id.
 * @param {object} result - the result to send.
 * @param {number} [status] - the HTTP status.
 * @returns {Response} the response.
 */
export function rpcEnvelope(rpcId, result, status = 200) {
	return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

/**
 * Register one exact Fetch route per endpoint.
 *
 * @param {object} ctx - the plugin context.
 * @param {(endpoint: string, payload: object, signal: AbortSignal) => Promise<object>} handler - the service call.
 * @returns {() => void} a disposer that unregisters every route.
 */
export function registerRpcRoutes(ctx, handler) {
	const disposers = [];
	for (const endpoint of RPC_ENDPOINTS) {
		const expected = rpcMethod(endpoint);
		const disposer = ctx.connection.fetch.register({
			path: rpcRoutePath(endpoint),
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
				if (contentType !== 'application/json') {
					return new Response(
						JSON.stringify({
							type: 'server-response',
							rpcId: 'unknown',
							result: rpcError('gateway/bad-request', 'content type must be application/json'),
						}),
						{ status: 415, headers: { 'content-type': 'application/json' } },
					);
				}
				let message;
				try {
					message = await request.json();
				} catch {
					return new Response(
						JSON.stringify({
							type: 'server-response',
							rpcId: 'unknown',
							result: rpcError('gateway/bad-request', 'body is not JSON'),
						}),
						{ status: 400, headers: { 'content-type': 'application/json' } },
					);
				}
				const rpcId =
					message && typeof message === 'object' && typeof message.rpcId === 'string' ? message.rpcId : 'unknown';
				if (!message || message.type !== 'client-request' || message.method !== expected) {
					return rpcEnvelope(rpcId, rpcError('unknown-endpoint', `method must be ${JSON.stringify(expected)}`), 400);
				}
				try {
					const value = await handler(endpoint, message.payload ?? {}, request.signal);
					return rpcEnvelope(rpcId, { ok: true, value });
				} catch (error) {
					return rpcEnvelope(rpcId, { ok: false, error: toErrorPayload(error) });
				}
			},
		});
		disposers.push(disposer);
	}
	return () => {
		for (const disposer of disposers.reverse()) {
			try {
				disposer();
			} catch {
				// A route that is already gone needs no cleanup.
			}
		}
	};
}
