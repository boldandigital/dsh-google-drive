/**
 * @local/google-drive — host half.
 *
 * Gives the browser half of this plugin a Google Drive account manager: add
 * an account by OAuth or by service-account key, list and remove accounts,
 * and browse Drive files with them. The plugin speaks to Google over plain
 * REST (`fetch`) and to the harness over the loopback Connection RPC
 * channel, so it adds no npm dependency of its own.
 *
 * Secrets never travel over the RPC channel and never reach the bundle
 * patch: an OAuth refresh token and a service-account key live in the
 * harness credential store, and each service account gets its own private
 * copy of its key file. The copy matters — the upstream MCP server deletes
 * the file an account points at when that account is removed, and two
 * accounts on one machine can share one key file.
 */

import { resolveOptions } from './host/options.js';
import { registerRpcRoutes } from './host/rpc.js';
import { renderReferenceContext, rewriteMessage } from './host/references.js';
import { GoogleDriveService } from './host/service.js';
import { buildDriveTools } from './host/tools.js';

/** Service name this half registers on the plugin context. */
export const name = 'google-drive';

/** Host services this half needs. */
export const inject = ['connection', 'credentials', 'tools'];

/**
 * Call the service method behind one endpoint.
 *
 * @param {GoogleDriveService} service - the account manager.
 * @param {string} endpoint - the endpoint name.
 * @param {object} payload - the request payload.
 * @param {AbortSignal} [signal] - the caller's cancellation signal.
 * @returns {Promise<object>} the endpoint's result.
 */
async function dispatch(service, endpoint, payload, signal) {
	switch (endpoint) {
		case 'accounts/list':
			return await service.listAccounts();
		case 'oauth/start':
			return await service.startOauth(payload);
		case 'oauth/status':
			return await service.oauthStatus(payload);
		case 'oauth/cancel':
			return await service.cancelOauth(payload);
		case 'accounts/add-service':
			return await service.addServiceAccount(payload);
		case 'accounts/remove':
			return await service.removeAccount(payload);
		case 'onboarding/detect':
			return await service.detectOnboarding();
		case 'onboarding/create-service-key':
			return await service.createServiceKey(payload);
		case 'drive/list':
			return await service.listFiles(payload, signal);
		case 'drive/search':
			return await service.searchFiles(payload, signal);
		case 'drive/download':
			return await service.downloadFile(payload, signal);
		case 'drive/upload':
			return await service.uploadFile(payload, signal);
		case 'drive/get-file':
			return await service.getFile(payload, signal);
		default:
			throw new Error(`unknown endpoint: ${String(endpoint)}`);
	}
}

/**
 * Rewrite the Drive mentions in one step's messages.
 *
 * A mention that reaches the prompt as plain text is not yet something the
 * agent can act on — the agent cannot open a Drive path. So each mention is
 * rewritten into a readable label and the files it names are appended as a
 * context block that carries the account and the file id.
 *
 * @param {object[]} messages - the messages that would enter the step.
 * @returns {object[]} the messages, rewritten when they carried a mention.
 */
function enrichDriveMentions(messages) {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const enriched = messages.map((message) => {
		const kind = message?.source?.kind;
		if (message?.role !== 'user' && kind !== 'user') return message;
		const result = rewriteMessage(message);
		if (result.references.length === 0) return message;
		changed = true;
		return {
			...result.message,
			content: [
				...(Array.isArray(result.message.content) ? result.message.content : []),
				{ type: 'text', text: renderReferenceContext(result.references) },
			],
		};
	});
	return changed ? enriched : messages;
}

/**
 * Apply the plugin: mount the RPC routes and the agent tools.
 *
 * Every registration is owned by an effect, so the routes, the tools and the
 * OAuth loopback servers are all released when the plugin unloads.
 *
 * @param {object} ctx - plugin context with connection, credentials and tools services.
 * @param {object} config - raw plugin config from the bundle patch.
 */
export function apply(ctx, config = {}) {
	const options = resolveOptions(config);
	const service = new GoogleDriveService(ctx, options);
	// The bridge is written once at start-up so an account that was added
	// before a restart shows up in the upstream MCP server without the user
	// having to add it again. It is best effort: a failure is a warning, not
	// a boot error.
	void service.syncMirror();

	/*
	 * The mention resolver. It runs before the model step so a dragged or
	 * added Drive file reaches the agent as a named reference instead of an
	 * opaque string. The listener lives on the plugin context, so removing
	 * the plugin removes the enrichment with it.
	 */
	ctx.on(
		'agent/pre-step',
		async (_payload, next) => {
			const decision = await next();
			if (decision.kind === 'reject') return decision;
			return { ...decision, messages: enrichDriveMentions(decision.messages) };
		},
		{ prepend: true },
	);

	ctx.effect(() => {
		const disposers = [];
		disposers.push(registerRpcRoutes(ctx, (endpoint, payload, signal) => dispatch(service, endpoint, payload, signal)));
		for (const tool of buildDriveTools(service)) disposers.push(ctx.tools.register(tool));
		return () => {
			for (const disposer of disposers.reverse()) {
				try {
					disposer();
				} catch {
					// A registration that is already gone needs no cleanup.
				}
			}
			service.dispose();
		};
	}, 'google-drive: routes and tools');
}

export { ERROR_CODES, DriveError } from './host/errors.js';
export {
	DRIVE_MENTION_SCHEME,
	formatDriveMention,
	parseDriveMentions,
	renderReferenceContext,
	rewriteMessage,
} from './host/references.js';
export { EXPORT_FORMATS, EXPORT_MIME_TYPES, isGoogleNativeMime, normalizeDriveFile } from './host/drive.js';
export { base64url, escapeDriveQueryValue, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, signJwtAssertion } from './host/google-api.js';
export { ACCOUNT_NAME_PATTERN, assertAccountName, decodeNameSegment, encodeNameSegment, recordKeys } from './host/names.js';
export { RPC_ENDPOINTS, rpcMethod, rpcRoutePath } from './host/rpc.js';
export { assertServiceAccountKey, GoogleDriveService } from './host/service.js';
