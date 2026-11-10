/**
 * Configuration the host half accepts from the bundle patch.
 *
 * Everything is optional: the plugin must boot with an empty config and still
 * be able to add an account, so each field falls back to a usable default
 * instead of failing the plugin.
 */

import os from 'node:os';
import path from 'node:path';

/** Drive scope used when the caller names none. */
export const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Normalize the raw plugin config into the shape the rest of the host uses.
 *
 * `storeDir` is the compatibility store the upstream MCP server reads
 * (`~/.google-mcp` by default); it holds the private copies of every secret
 * this plugin manages, never a path to a file the user pasted elsewhere.
 *
 * `oauthClientId` and `oauthClientSecret` are the OAuth client the plugin
 * may ship with. When they are set, a user can sign in with one click,
 * without building a client in the Cloud console first. They are empty by
 * default, and the plugin behaves exactly the same without them.
 *
 * @param {object} config - raw plugin config from the bundle patch.
 * @returns {{scopes: string[], defaultAccount: string|null, mcpBridge: boolean, storeDir: string, oauthClientId: string, oauthClientSecret: string}} resolved options.
 */
export function resolveOptions(config) {
	const raw = config && typeof config === 'object' ? config : {};
	const scopes = Array.isArray(raw.scopes)
		? raw.scopes.filter((scope) => typeof scope === 'string' && scope.trim() !== '').map((scope) => scope.trim())
		: [];
	const storeDir =
		typeof raw.storeDir === 'string' && raw.storeDir.trim() !== ''
			? path.resolve(raw.storeDir.trim())
			: path.join(os.homedir(), '.google-mcp');
	return {
		scopes: scopes.length > 0 ? scopes : [...DEFAULT_SCOPES],
		defaultAccount:
			typeof raw.defaultAccount === 'string' && raw.defaultAccount.trim() !== '' ? raw.defaultAccount.trim() : null,
		mcpBridge: raw.mcpBridge !== false,
		storeDir,
		/*
		 * The OAuth client the plugin ships, when it ships one. Google calls
		 * the secret of an installed (desktop) client no secret at all — "the
		 * client secret is obviously not treated as a secret", in Google's own
		 * words — so it may travel with the package. The id is public anyway.
		 * An empty string means the plugin has none, and every user has to
		 * bring a client of their own.
		 */
		oauthClientId: typeof raw.oauthClientId === 'string' ? raw.oauthClientId.trim() : '',
		oauthClientSecret: typeof raw.oauthClientSecret === 'string' ? raw.oauthClientSecret.trim() : '',
	};
}
