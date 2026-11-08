/**
 * The Google Drive account manager.
 *
 * One service object owns every operation the contract describes: the RPC
 * endpoints and the agent tools both call into it, so both halves behave
 * identically. Secrets live in the credential service; the private files in
 * the compatibility store are the fallback and the bridge to the upstream MCP
 * server.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SecretStore } from './credentials.js';
import { DriveClient, guessMimeType } from './drive.js';
import { DriveError, ERROR_CODES, invalidInput, unknownAccount } from './errors.js';
import { pathExists, readJsonFile, resolveUserPath } from './files.js';
import { GoogleAuthClient } from './google-api.js';
import { McpMirror } from './mirror.js';
import { assertAccountName } from './names.js';
import { OAuthFlowManager } from './oauth-flow.js';
import { AccountRepository } from './repository.js';

/** How long before its expiry an access token is refreshed. */
const TOKEN_REFRESH_MARGIN_MS = 60000;

/**
 * Check that a parsed object really is a service-account key.
 *
 * @param {unknown} key - the parsed key.
 * @returns {object} the key.
 * @throws {DriveError} `invalid-key` when the key cannot be used.
 */
export function assertServiceAccountKey(key) {
	if (!key || typeof key !== 'object' || Array.isArray(key)) {
		throw new DriveError(ERROR_CODES.INVALID_KEY, 'The service-account key is not a JSON object.', { field: 'keyJson' });
	}
	if (key.type !== 'service_account') {
		throw new DriveError(
			ERROR_CODES.INVALID_KEY,
			`A service-account key has "type": "service_account"; this one says "${String(key.type ?? 'nothing')}".`,
			{ field: 'keyJson' },
		);
	}
	if (typeof key.client_email !== 'string' || key.client_email.trim() === '') {
		throw new DriveError(ERROR_CODES.INVALID_KEY, 'The service-account key has no client_email.', { field: 'keyJson' });
	}
	if (typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) {
		throw new DriveError(
			ERROR_CODES.INVALID_KEY,
			'The service-account key has no PEM private key; paste the whole key file.',
			{ field: 'keyJson' },
		);
	}
	return key;
}

/**
 * Build a file-list result.
 *
 * The continuation token is only present when Drive sent one: a property
 * holding `undefined` is not lossless JSON, and the harness rejects a tool
 * result that carries one.
 *
 * @param {{files: object[], nextPageToken: string|undefined}} result - the Drive page.
 * @returns {{files: object[], nextPageToken?: string}} the result payload.
 */
function withPageToken(result) {
	const payload = { files: result.files };
	if (typeof result.nextPageToken === 'string' && result.nextPageToken !== '') payload.nextPageToken = result.nextPageToken;
	return payload;
}

/**
 * Look for an installed `google-workspace-mcp` server.
 *
 * @returns {Promise<boolean>} true when the server package is installed.
 */
export async function detectMcpServer() {
	const profilesDir = path.join(os.homedir(), '.dsh', 'profiles');
	try {
		const profiles = await readdir(profilesDir, { withFileTypes: true });
		for (const profile of profiles) {
			if (!profile.isDirectory()) continue;
			const candidate = path.join(profilesDir, profile.name, 'node_modules', 'google-workspace-mcp');
			try {
				if ((await stat(candidate)).isDirectory()) return true;
			} catch {
				// This profile does not have the server installed.
			}
		}
	} catch {
		// No profile directory at all: the server is not installed.
	}
	return false;
}

/**
 * The account manager the endpoints and the tools share.
 */
export class GoogleDriveService {
	/**
	 * @param {object} ctx - the plugin context.
	 * @param {object} options - the resolved plugin options.
	 */
	constructor(ctx, options) {
		this.ctx = ctx;
		this.options = options;
		this.store = new SecretStore(ctx);
		this.repository = new AccountRepository(options, this.store);
		this.mirror = new McpMirror(options, this.repository);
		this.auth = new GoogleAuthClient();
		this.flows = new OAuthFlowManager({
			onComplete: (flow, code) => this.completeOauthFlow(flow, code),
		});
		this.tokenCache = new Map();
		this.tokenRequests = new Map();
		if (!this.store.available) {
			// Worth one line in the log: the profile has no credential
			// service, so secrets live in the compatibility store instead.
			ctx.logger?.warn(
				'google-drive: no credential service is mounted, so secrets are kept in %s instead.',
				options.storeDir,
			);
		}
	}

	/** Where the secrets live right now. */
	get storageMode() {
		return this.store.available ? 'credentials' : 'files';
	}

	/**
	 * List every account and the state of the compatibility bridge.
	 *
	 * Accounts the upstream MCP server added are listed too, marked as
	 * foreign, so the panel shows everything this machine can reach instead
	 * of hiding the accounts that already work.
	 *
	 * @returns {Promise<object>} the contract's `accounts/list` payload.
	 */
	async listAccounts() {
		const names = await this.repository.listAccountNames();
		const accounts = [];
		for (const name of names) {
			const metadata = await this.repository.readAccount(name);
			if (!metadata) continue;
			const { status } = await this.repository.loadSecret(metadata);
			accounts.push({
				name,
				email: typeof metadata.email === 'string' ? metadata.email : null,
				type: metadata.type === 'service_account' ? 'service_account' : 'oauth',
				subject: typeof metadata.subject === 'string' ? metadata.subject : null,
				addedAt: typeof metadata.addedAt === 'string' ? metadata.addedAt : null,
				scopes: Array.isArray(metadata.scopes) ? metadata.scopes : [],
				status,
				foreign: false,
			});
		}
		for (const foreign of await this.foreignAccounts()) {
			if (accounts.some((account) => account.name === foreign.name)) continue;
			accounts.push(foreign);
		}
		return {
			accounts,
			mcpBridge: {
				enabled: this.options.mcpBridge,
				path: this.options.mcpBridge ? this.options.storeDir : null,
				installed: await detectMcpServer(),
			},
			storage: this.storageMode,
		};
	}

	/**
	 * The accounts the upstream MCP server manages.
	 *
	 * These are read-only here: the plugin did not create them, and the
	 * server that owns them may still be using them. A service account's key
	 * file can even be shared with another account, so removing one through
	 * this plugin would break the other.
	 *
	 * @returns {Promise<object[]>} the foreign account records.
	 */
	async foreignAccounts() {
		if (!this.options.mcpBridge) return [];
		let shared;
		try {
			shared = await this.mirror.read();
		} catch {
			return [];
		}
		const owned = new Set(await this.repository.listAccountNames());
		const foreign = [];
		for (const [name, entry] of Object.entries(shared.accounts)) {
			if (owned.has(name) || !entry || typeof entry !== 'object') continue;
			const kind = entry.kind === 'service_account' || entry.kind === 'service_account_impersonating'
				? 'service_account'
				: 'oauth';
			const metadata = {
				name,
				email: typeof entry.email === 'string' ? entry.email : null,
				type: kind,
				subject: typeof entry.subject === 'string' ? entry.subject : null,
				addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
				scopes: [],
				status: 'unknown',
				foreign: true,
				tokenPath: typeof entry.tokenPath === 'string' ? entry.tokenPath : null,
				credentialsPath: typeof entry.credentialsPath === 'string' ? entry.credentialsPath : null,
			};
			// The status is read from the credentials the upstream server
			// keeps, so the panel shows whether the account can actually be
			// used rather than a blank.
			const loaded = await this.loadForeignSecret(metadata);
			metadata.status = loaded.status;
			foreign.push(metadata);
		}
		return foreign;
	}

	/**
	 * Start an OAuth sign-in.
	 *
	 * @param {object} payload - the `oauth/start` payload.
	 * @returns {Promise<{flowId: string, authUrl: string, expiresAt: number}>} the flow handle.
	 */
	async startOauth(payload) {
		const name = assertAccountName(payload?.name);
		const clientId = typeof payload?.clientId === 'string' ? payload.clientId.trim() : '';
		if (clientId === '') {
			throw invalidInput('An OAuth client id is required.', { field: 'clientId' });
		}
		const clientSecret = typeof payload?.clientSecret === 'string' ? payload.clientSecret.trim() : '';
		const scopes = this.normalizeScopes(payload?.scopes);
		const existing = await this.repository.readAccount(name);
		if (existing) {
			throw invalidInput(`An account named "${name}" already exists; remove it before signing in again.`, {
				field: 'name',
			});
		}
		return this.flows.start({ name, clientId, clientSecret, scopes });
	}

	/**
	 * Report the state of one sign-in.
	 *
	 * @param {object} payload - the `oauth/status` payload.
	 * @returns {Promise<object>} the contract's `oauth/status` payload.
	 */
	async oauthStatus(payload) {
		const flowId = typeof payload?.flowId === 'string' ? payload.flowId : '';
		if (flowId === '') throw invalidInput('A flow id is required.', { field: 'flowId' });
		return this.flows.status(flowId);
	}

	/**
	 * Cancel one sign-in.
	 *
	 * @param {object} payload - the `oauth/cancel` payload.
	 * @returns {Promise<object>} an empty payload.
	 */
	async cancelOauth(payload) {
		const flowId = typeof payload?.flowId === 'string' ? payload.flowId : '';
		if (flowId === '') throw invalidInput('A flow id is required.', { field: 'flowId' });
		this.flows.cancel(flowId);
		return {};
	}

	/**
	 * Finish a sign-in once Google redirected back to the loopback server.
	 *
	 * @param {object} flow - the flow that received the code.
	 * @param {string} code - the authorization code.
	 * @returns {Promise<object>} the account record.
	 */
	async completeOauthFlow(flow, code) {
		const tokens = await this.auth.exchangeAuthorizationCode({
			code,
			codeVerifier: flow.verifier,
			clientId: flow.clientId,
			clientSecret: flow.clientSecret,
			redirectUri: flow.redirectUri,
		});
		if (!tokens.refreshToken) {
			throw new DriveError(
				ERROR_CODES.OAUTH_FAILED,
				'Google returned no offline refresh token. Grant access again so the consent screen can hand one over.',
				{},
			);
		}
		const email = await this.auth.fetchUserEmail(tokens.accessToken);
		await this.repository.writeOauthSecret(flow.name, {
			clientId: flow.clientId,
			clientSecret: flow.clientSecret,
			refreshToken: tokens.refreshToken,
		});
		const metadata = {
			name: flow.name,
			email,
			type: 'oauth',
			subject: null,
			addedAt: new Date().toISOString(),
			scopes: flow.scopes,
		};
		await this.repository.writeAccount(metadata);
		await this.syncMirror();
		return metadata;
	}

	/**
	 * Add a service account from a pasted key.
	 *
	 * @param {object} payload - the `accounts/add-service` payload.
	 * @returns {Promise<{account: object}>} the new account.
	 */
	async addServiceAccount(payload) {
		const name = assertAccountName(payload?.name);
		const raw = typeof payload?.keyJson === 'string' ? payload.keyJson : '';
		if (raw.trim() === '') {
			throw new DriveError(ERROR_CODES.INVALID_KEY, 'Paste the service-account key as JSON.', { field: 'keyJson' });
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new DriveError(
				ERROR_CODES.INVALID_KEY,
				`The service-account key is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ field: 'keyJson' },
			);
		}
		const key = assertServiceAccountKey(parsed);
		const subject = typeof payload?.subject === 'string' && payload.subject.trim() !== '' ? payload.subject.trim() : null;
		const existing = await this.repository.readAccount(name);
		if (existing) {
			throw invalidInput(`An account named "${name}" already exists; remove it before adding it again.`, {
				field: 'name',
			});
		}
		// The key is copied into this plugin's own directory. The upstream
		// server unlinks whatever file an account points at, and two accounts
		// can share one key file, so pointing at a file the user pasted
		// elsewhere would let one removal destroy the other account.
		await this.repository.writeServiceKey(name, key);
		const metadata = {
			name,
			email: key.client_email,
			type: 'service_account',
			subject,
			addedAt: new Date().toISOString(),
			scopes: this.options.scopes,
		};
		await this.repository.writeAccount(metadata);
		await this.syncMirror();
		return { account: await this.describeAccount(name) };
	}

	/**
	 * Remove one account and everything this plugin stored for it.
	 *
	 * @param {object} payload - the `accounts/remove` payload.
	 * @returns {Promise<object>} the contract's `accounts/remove` payload.
	 */
	async removeAccount(payload) {
		const name = assertAccountName(payload?.name);
		const metadata = await this.repository.readAccount(name);
		if (!metadata) {
			// An account the upstream MCP server owns is not this plugin's to
			// remove: its key file can be shared with another account, and the
			// server that created it may still be using it.
			const foreign = (await this.foreignAccounts()).find((account) => account.name === name);
			if (foreign) {
				throw new DriveError(
					ERROR_CODES.INVALID_KEY,
					`The account "${name}" belongs to the Google Workspace MCP server, not to this plugin. Remove it there instead.`,
					{ field: 'name', account: name, foreign: true },
				);
			}
			throw unknownAccount(name, await this.repository.listAccountNames());
		}
		const referenced = await this.mirror.referencedPaths([name]);
		const { kept } = await this.repository.removeAccount(name, referenced);
		this.tokenCache.delete(name);
		this.tokenRequests.delete(name);
		const mirror = await this.syncMirror();
		const warnings = [];
		for (const file of kept) {
			warnings.push(`Kept ${file}: another account still points at it.`);
		}
		if (mirror.warning) warnings.push(mirror.warning);
		return { removed: true, warnings };
	}

	/**
	 * Describe one account for a result payload.
	 *
	 * @param {string} name - the account name.
	 * @returns {Promise<object>} the account record.
	 */
	async describeAccount(name) {
		const metadata = await this.repository.readAccount(name);
		if (!metadata) throw unknownAccount(name, await this.repository.listAccountNames());
		const { status } = await this.repository.loadSecret(metadata);
		return {
			name,
			email: typeof metadata.email === 'string' ? metadata.email : null,
			type: metadata.type === 'service_account' ? 'service_account' : 'oauth',
			subject: typeof metadata.subject === 'string' ? metadata.subject : null,
			addedAt: typeof metadata.addedAt === 'string' ? metadata.addedAt : null,
			scopes: Array.isArray(metadata.scopes) ? metadata.scopes : [],
			status,
		};
	}

	/**
	 * List the files in one folder.
	 *
	 * @param {object} payload - the `drive/list` payload.
	 * @param {AbortSignal} [payload.signal] - the caller's cancellation signal.
	 * @returns {Promise<object>} the contract's `drive/list` payload.
	 */
	async listFiles(payload, signal) {
		const account = await this.requireAccount(payload?.account);
		const folderId = typeof payload?.folderId === 'string' && payload.folderId.trim() !== '' ? payload.folderId.trim() : 'root';
		const result = await this.driveClient(account).listFiles({
			folderId,
			pageSize: payload?.pageSize,
			query: typeof payload?.query === 'string' ? payload.query : undefined,
			signal,
		});
		return withPageToken(result);
	}

	/**
	 * Search for files by name.
	 *
	 * @param {object} payload - the `drive/search` payload.
	 * @param {AbortSignal} [payload.signal] - the caller's cancellation signal.
	 * @returns {Promise<object>} the contract's `drive/search` payload.
	 */
	async searchFiles(payload, signal) {
		const account = await this.requireAccount(payload?.account);
		const result = await this.driveClient(account).searchFiles({
			query: payload?.query,
			pageSize: payload?.pageSize,
			signal,
		});
		return withPageToken(result);
	}

	/**
	 * Read the metadata of one file.
	 *
	 * @param {object} payload - the `drive/get-file` payload.
	 * @param {AbortSignal} [payload.signal] - the caller's cancellation signal.
	 * @returns {Promise<object>} the contract's `drive/get-file` payload.
	 */
	async getFile(payload, signal) {
		const account = await this.requireAccount(payload?.account);
		const fileId = typeof payload?.fileId === 'string' ? payload.fileId.trim() : '';
		if (fileId === '') throw invalidInput('A file id is required.', { field: 'fileId' });
		const file = await this.driveClient(account).getFile(fileId, signal);
		return { file };
	}

	/**
	 * Download one file to the host's disk.
	 *
	 * @param {object} payload - the `drive/download` payload.
	 * @param {AbortSignal} [payload.signal] - the caller's cancellation signal.
	 * @returns {Promise<object>} the contract's `drive/download` payload.
	 */
	async downloadFile(payload, signal) {
		const account = await this.requireAccount(payload?.account);
		const fileId = typeof payload?.fileId === 'string' ? payload.fileId.trim() : '';
		if (fileId === '') throw invalidInput('A file id is required.', { field: 'fileId' });
		const target = typeof payload?.path === 'string' && payload.path.trim() !== '' ? payload.path.trim() : '';
		if (target === '') throw invalidInput('A destination path is required.', { field: 'path' });
		const { bytes } = await this.driveClient(account).downloadFile({
			fileId,
			exportFormat: typeof payload?.exportFormat === 'string' ? payload.exportFormat : undefined,
			signal,
		});
		const destination = resolveUserPath(target);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, bytes);
		return { path: destination, bytes: bytes.length };
	}

	/**
	 * Upload one local file.
	 *
	 * @param {object} payload - the `drive/upload` payload.
	 * @param {AbortSignal} [payload.signal] - the caller's cancellation signal.
	 * @returns {Promise<object>} the contract's `drive/upload` payload.
	 */
	async uploadFile(payload, signal) {
		const account = await this.requireAccount(payload?.account);
		const source = typeof payload?.localPath === 'string' && payload.localPath.trim() !== '' ? payload.localPath.trim() : '';
		if (source === '') throw invalidInput('A local path is required.', { field: 'localPath' });
		const resolved = resolveUserPath(source);
		let bytes;
		try {
			bytes = await readFile(resolved);
		} catch (error) {
			throw new DriveError(
				ERROR_CODES.IO,
				`Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
				{ path: resolved },
			);
		}
		const name =
			typeof payload?.name === 'string' && payload.name.trim() !== '' ? payload.name.trim() : path.basename(resolved);
		const file = await this.driveClient(account).uploadFile({
			bytes,
			name,
			folderId: typeof payload?.folderId === 'string' ? payload.folderId : undefined,
			mimeType:
				typeof payload?.mimeType === 'string' && payload.mimeType.trim() !== ''
					? payload.mimeType.trim()
					: guessMimeType(resolved),
			signal,
		});
		return { file };
	}

	/**
	 * Resolve the account a request names.
	 *
	 * An account the upstream MCP server owns resolves too: its credentials
	 * are read from the file its own entry points at, and nothing is written
	 * back, so using it here cannot disturb the server that owns it.
	 *
	 * @param {unknown} name - the account name from the payload.
	 * @returns {Promise<object>} the account metadata.
	 */
	async requireAccount(name) {
		const accountName = assertAccountName(name);
		const metadata = await this.repository.readAccount(accountName);
		if (metadata) return metadata;
		const foreign = await this.foreignAccount(accountName);
		if (foreign) return foreign;
		throw unknownAccount(accountName, await this.repository.listAccountNames());
	}

	/**
	 * Resolve one account the upstream MCP server owns.
	 *
	 * @param {string} name - the account name.
	 * @returns {Promise<object|null>} the account metadata, or null when unknown.
	 */
	async foreignAccount(name) {
		if (!this.options.mcpBridge) return null;
		let shared;
		try {
			shared = await this.mirror.read();
		} catch {
			return null;
		}
		const entry = shared.accounts[name];
		if (!entry || typeof entry !== 'object') return null;
		const serviceAccount = entry.kind === 'service_account' || entry.kind === 'service_account_impersonating';
		const metadata = {
			name,
			email: typeof entry.email === 'string' ? entry.email : null,
			type: serviceAccount ? 'service_account' : 'oauth',
			subject: typeof entry.subject === 'string' && entry.subject !== '' ? entry.subject : null,
			addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
			scopes: this.options.scopes,
			foreign: true,
			tokenPath: typeof entry.tokenPath === 'string' ? entry.tokenPath : null,
			credentialsPath: typeof entry.credentialsPath === 'string' ? entry.credentialsPath : null,
		};
		const { secret } = await this.loadForeignSecret(metadata);
		return secret ? { ...metadata, secret } : metadata;
	}

	/**
	 * Read the credentials of an account the upstream server owns.
	 *
	 * The upstream layout is either a service-account key file or an OAuth
	 * token file beside a client secret; both are read in place and never
	 * copied, because the file may be shared with another account.
	 *
	 * @param {object} metadata - the foreign account metadata.
	 * @returns {Promise<{status: string, secret: object|null}>} the state and the secret.
	 */
	async loadForeignSecret(metadata) {
		const tokenPath = metadata.tokenPath;
		if (typeof tokenPath !== 'string' || tokenPath === '') return { status: 'unknown', secret: null };
		// A credential file that is not there at all is a broken account, not
		// an unknown one: the account cannot work whatever the file held.
		if (!(await pathExists(tokenPath))) return { status: 'error', secret: null };
		let file;
		try {
			file = await readJsonFile(tokenPath);
		} catch {
			// The file is there but unreadable: the account is broken.
			return { status: 'error', secret: null };
		}
		if (!file || typeof file !== 'object') return { status: 'error', secret: null };
		if (file.type === 'service_account') {
			if (typeof file.private_key !== 'string' || file.private_key === '') {
				return { status: 'error', secret: null };
			}
			return { status: 'ready', secret: { key: file } };
		}
		const refreshToken = typeof file.refresh_token === 'string' ? file.refresh_token : null;
		if (!refreshToken) return { status: 'error', secret: null };
		let clientId = typeof file.client_id === 'string' ? file.client_id : null;
		let clientSecret = typeof file.client_secret === 'string' ? file.client_secret : null;
		// The upstream server keeps the client secret in a separate file; it
		// is optional here because a refresh token can be used without it.
		if (metadata.credentialsPath) {
			const client = await readJsonFile(metadata.credentialsPath);
			const key = client?.installed ?? client?.web ?? null;
			if (key && typeof key === 'object') {
				clientId = typeof key.client_id === 'string' ? key.client_id : clientId;
				clientSecret = typeof key.client_secret === 'string' ? key.client_secret : clientSecret;
			}
		}
		if (!clientId) return { status: 'error', secret: null };
		return { status: 'ready', secret: { clientId, clientSecret: clientSecret ?? '', refreshToken } };
	}

	/**
	 * Build a Drive client bound to one account.
	 *
	 * @param {object} account - the account metadata.
	 * @returns {DriveClient} the client.
	 */
	driveClient(account) {
		return new DriveClient({ getAccessToken: () => this.accessToken(account) });
	}

	/**
	 * Get a usable access token for one account.
	 *
	 * Tokens are cached in memory only; nothing but the refresh token and the
	 * service-account key is ever written to disk.
	 *
	 * @param {object} account - the account metadata.
	 * @returns {Promise<string>} the access token.
	 */
	async accessToken(account) {
		const cached = this.tokenCache.get(account.name);
		if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return cached.token;
		const running = this.tokenRequests.get(account.name);
		if (running) return running;
		const task = (async () => {
			// An account the upstream server owns carries its secret with it;
			// one of ours has to be read back from the store.
			const loaded = account.secret
				? { status: 'ready', secret: account.secret }
				: await this.repository.loadSecret(account);
			const { status, secret } = loaded;
			if (status !== 'ready' || !secret) {
				throw new DriveError(
					ERROR_CODES.OAUTH_FAILED,
					`The account "${account.name}" has no usable credentials. Sign it in again or add the key again.`,
					{ account: account.name, status },
				);
			}
			const granted =
				account.type === 'service_account'
					? await this.auth.serviceAccountAccessToken({
							key: secret.key,
							scopes: Array.isArray(account.scopes) && account.scopes.length > 0 ? account.scopes : this.options.scopes,
							subject: typeof account.subject === 'string' && account.subject !== '' ? account.subject : undefined,
						})
					: await this.auth.refreshAccessToken({
							refreshToken: secret.refreshToken,
							clientId: secret.clientId,
							clientSecret: secret.clientSecret,
						});
			const token = granted.accessToken;
			this.tokenCache.set(account.name, {
				token,
				expiresAt: Date.now() + Math.max(0, granted.expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS),
			});
			return token;
		})();
		this.tokenRequests.set(account.name, task);
		try {
			return await task;
		} finally {
			if (this.tokenRequests.get(account.name) === task) this.tokenRequests.delete(account.name);
		}
	}

	/**
	 * Normalize the scopes of one request.
	 *
	 * @param {unknown} scopes - the scopes the caller named.
	 * @returns {string[]} the scopes to request.
	 */
	normalizeScopes(scopes) {
		if (!Array.isArray(scopes)) return [...this.options.scopes];
		const cleaned = scopes
			.filter((scope) => typeof scope === 'string' && scope.trim() !== '')
			.map((scope) => scope.trim());
		return cleaned.length > 0 ? cleaned : [...this.options.scopes];
	}

	/**
	 * Write the compatibility mirror.
	 *
	 * The mirror is best effort: a failure is reported as a warning and never
	 * fails the operation that asked for it.
	 *
	 * @returns {Promise<{written: boolean, warning: string|null}>} what happened.
	 */
	async syncMirror() {
		if (!this.options.mcpBridge) return { written: false, warning: null };
		try {
			const entries = new Map();
			for (const name of await this.repository.listAccountNames()) {
				const metadata = await this.repository.readAccount(name);
				if (!metadata) continue;
				entries.set(name, this.mirrorEntry(name, metadata));
			}
			// An empty store does not need a shared file: creating one would
			// only leave an account-less file behind.
			if (entries.size === 0 && !(await pathExists(this.mirror.accountsPath))) {
				return { written: false, warning: null };
			}
			await this.mirror.writeAccounts(entries);
			return { written: true, warning: null };
		} catch (error) {
			return {
				written: false,
				warning: `The compatibility mirror could not be written: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * Build the mirror entry for one account.
	 *
	 * @param {string} name - the account name.
	 * @param {object} metadata - the account metadata.
	 * @returns {object} the entry the upstream server reads.
	 */
	mirrorEntry(name, metadata) {
		const serviceAccount = metadata.type === 'service_account';
		const entry = {
			name,
			email: typeof metadata.email === 'string' ? metadata.email : undefined,
			tokenPath: serviceAccount ? this.repository.keyPath(name) : this.repository.tokenPath(name),
			addedAt: typeof metadata.addedAt === 'string' ? metadata.addedAt : new Date().toISOString(),
			kind: serviceAccount ? (metadata.subject ? 'service_account_impersonating' : 'service_account') : 'oauth',
		};
		if (typeof metadata.subject === 'string' && metadata.subject !== '') entry.subject = metadata.subject;
		if (!serviceAccount) entry.credentialsPath = this.repository.credentialPath(name);
		return entry;
	}

	/** Release every resource this service holds. */
	dispose() {
		this.flows.dispose();
		this.tokenCache.clear();
		this.tokenRequests.clear();
	}
}
