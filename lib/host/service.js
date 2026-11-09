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
import { DriveClient, MAX_DOWNLOAD_BYTES, guessMimeType } from './drive.js';
import { DriveError, ERROR_CODES, invalidInput, unknownAccount } from './errors.js';
import { pathExists, readJsonFile, resolveUserPath } from './files.js';
import { GoogleAuthClient } from './google-api.js';
import { McpMirror } from './mirror.js';
import { assertAccountName } from './names.js';
import { OAuthFlowManager } from './oauth-flow.js';
import { OnboardingProbe } from './onboarding.js';
import { AccountRepository } from './repository.js';

/** How long before its expiry an access token is refreshed. */
const TOKEN_REFRESH_MARGIN_MS = 60000;

/**
 * How long the answer to "does this account sign in?" is remembered.
 *
 * A working account is cheap to re-check — its token is cached for much
 * longer than this — but a broken one costs a round trip to Google, so the
 * refusal is remembered a little longer.
 */
const PROBE_TTL_MS = 60000;

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
		this.onboarding = new OnboardingProbe({ storeDir: options.storeDir });
		this.tokenCache = new Map();
		this.tokenRequests = new Map();
		this.rootIds = new Map();
		/* What the last probe of each account found out. */
		this.probes = new Map();
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
	 * Whether one account sees a pile of shared items at its root.
	 *
	 * A plain service account sees only what was shared with it, and Drive
	 * reports those items with no parent at all. A service account that
	 * impersonates a Workspace user is different: it acts as that user, so it
	 * has a real root folder like any other account.
	 *
	 * @param {object} account - the account record.
	 * @returns {boolean} whether the shared-root listing applies.
	 */
	static isSharedRootAccount(account) {
		return account?.type === 'service_account' && !account?.impersonating;
	}

	/**
	 * Find out whether one account's credentials really work.
	 *
	 * A key file that parses is not a working account: the token it signs can
	 * still be refused, and a service account that impersonates a Workspace
	 * user is refused unless an administrator authorized it. So the status an
	 * account carries is the answer to one question — does it sign in — and
	 * not "is there a file on disk".
	 *
	 * The answer is remembered for a minute, so a broken account does not
	 * turn every list into a round trip to Google.
	 *
	 * @param {object} account - the account record to probe.
	 * @returns {Promise<object>} the account record, with its status.
	 */
	async probeAccount(account) {
		const cached = this.probes.get(account.name);
		if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
			account.status = cached.status;
			account.error = cached.error;
			return account;
		}
		let status = account.status;
		let error = null;
		if (status !== 'error') {
			try {
				// An account the upstream server owns keeps its secret there,
				// not in this plugin's store, so it is read in place before
				// the sign-in is tried. The secret stays in this local copy:
				// the record that goes back to the browser must never carry
				// a refresh token or a client secret.
				let secret = account.secret || null;
				if (account.foreign && !secret) {
					secret = (await this.loadForeignSecret(account)).secret;
				}
				await this.accessToken(secret ? { ...account, secret } : account);
				status = 'ready';
			} catch (problem) {
				status = 'error';
				error = problem instanceof Error ? problem.message : String(problem);
			}
		} else {
			error = 'The credentials of this account cannot be read.';
		}
		this.probes.set(account.name, { status, error, at: Date.now() });
		account.status = status;
		account.error = error;
		return account;
	}

	/**
	 * List every account and the state of the compatibility bridge.
	 *
	 * Accounts the upstream MCP server added are listed too, marked as
	 * foreign, so the panel shows everything this machine can reach instead
	 * of hiding the accounts that already work.
	 *
	 * @param {object} [payload] - the `accounts/list` payload.
	 * @returns {Promise<object>} the contract's `accounts/list` payload.
	 */
	async listAccounts(payload) {
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
				impersonating:
					metadata.type === 'service_account' &&
					typeof metadata.subject === 'string' &&
					metadata.subject !== '',
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
		// Probing means asking Google whether the credentials work, which is
		// a network round trip per account. It is done when the caller asks
		// for it — the settings section does, the agent tool does not.
		if (payload?.probe === true) {
			for (const account of accounts) {
				await this.probeAccount(account);
			}
		}
		// What leaves this function is what the browser sees. A path into
		// the credential store, or a secret that came with it, is none of
		// the browser's business.
		const listed = accounts.map((account) => {
			const clean = { ...account };
			delete clean.secret;
			delete clean.tokenPath;
			delete clean.credentialsPath;
			return clean;
		});
		return {
			accounts: listed,
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
		const hidden = new Set(await this.repository.listHiddenAccounts());
		const foreign = [];
		for (const [name, entry] of Object.entries(shared.accounts)) {
			if (owned.has(name) || hidden.has(name) || !entry || typeof entry !== 'object') continue;
			const kind = entry.kind === 'service_account' || entry.kind === 'service_account_impersonating'
				? 'service_account'
				: 'oauth';
			const subject = typeof entry.subject === 'string' && entry.subject !== '' ? entry.subject : null;
			const metadata = {
				name,
				email: typeof entry.email === 'string' ? entry.email : null,
				type: kind,
				subject,
				impersonating: kind === 'service_account' && subject !== null,
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
		const scopes = this.normalizeScopes(payload?.scopes);
		/*
		 * A re-authorisation reuses the OAuth client the account was created
		 * with. The client id and secret are stored with the account, so the
		 * user does not have to find them again to renew an access that
		 * expired or was revoked: one click is enough.
		 */
		if (payload?.useStored === true) {
			const existing = await this.repository.readAccount(name);
			if (!existing) {
				throw unknownAccount(name, await this.repository.listAccountNames());
			}
			const loaded = await this.repository.loadSecret(existing);
			if (loaded.status !== 'ready' || !loaded.secret?.clientId) {
				throw invalidInput(
					`The OAuth client of "${name}" is not stored, so it cannot sign in again. Add the account with its client id and secret instead.`,
					{ field: 'name', account: name },
				);
			}
			return this.flows.start({
				name,
				clientId: loaded.secret.clientId,
				clientSecret: typeof loaded.secret.clientSecret === 'string' ? loaded.secret.clientSecret : '',
				scopes: Array.isArray(existing.scopes) && existing.scopes.length > 0 ? existing.scopes : scopes,
				replace: true,
			});
		}
		const clientId = typeof payload?.clientId === 'string' ? payload.clientId.trim() : '';
		if (clientId === '') {
			throw invalidInput('An OAuth client id is required.', { field: 'clientId' });
		}
		const clientSecret = typeof payload?.clientSecret === 'string' ? payload.clientSecret.trim() : '';
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
		/*
		 * A re-authorisation keeps the account it renews: the name, the day
		 * it was added and the scopes it was granted stay as they were, so
		 * the account list does not pretend that signing in again created a
		 * new account. Only the token and the address behind it are new.
		 */
		const previous = await this.repository.readAccount(flow.name);
		const metadata = {
			name: flow.name,
			email,
			type: 'oauth',
			subject: null,
			addedAt:
				flow.replace && previous && typeof previous.addedAt === 'string'
					? previous.addedAt
					: new Date().toISOString(),
			scopes: flow.scopes,
		};
		await this.repository.writeAccount(metadata);
		this.forgetAccount(flow.name);
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
	 * Change an account that was already added.
	 *
	 * An account is not a one-way door: the key behind it can be replaced, the
	 * Workspace user it impersonates can be changed or taken away, and the
	 * account can be renamed. Everything the change invalidates — the cached
	 * token, the remembered probe, the known root folder — is forgotten, so
	 * the next request signs in with the new material instead of the old.
	 *
	 * @param {object} payload - the `accounts/update` payload.
	 * @returns {Promise<{account: object, renamed: boolean}>} the account after the change.
	 */
	async updateAccount(payload) {
		const name = assertAccountName(payload?.name);
		const metadata = await this.repository.readAccount(name);
		if (!metadata) {
			const foreign = (await this.foreignAccounts()).find((account) => account.name === name);
			if (foreign) {
				throw invalidInput(
					`"${name}" belongs to the Google Workspace MCP server, not to this plugin. Change it there.`,
					{ field: 'name', account: name },
				);
			}
			throw unknownAccount(name, await this.repository.listAccountNames());
		}
		const current = { ...metadata };
		const changed = [];

		/* The Workspace user the service account acts as. An empty string
		 * clears it: a plain service account sees the files that were shared
		 * with it, and needs no administrator at all. */
		if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'subject')) {
			if (current.type !== 'service_account') {
				throw invalidInput('Only a service account can act as a Workspace user.', { field: 'subject' });
			}
			const raw = payload.subject;
			const subject = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
			if ((current.subject ?? null) !== subject) {
				current.subject = subject;
				changed.push(subject ? 'subject' : 'subject-cleared');
			}
		}

		/* A new key file replaces the old one. The account keeps its name and
		 * its place in the list, so a rotated key does not mean a new
		 * account. */
		if (typeof payload?.keyJson === 'string' && payload.keyJson.trim() !== '') {
			if (current.type !== 'service_account') {
				throw invalidInput('Only a service account has a key file.', { field: 'keyJson' });
			}
			let parsed;
			try {
				parsed = JSON.parse(payload.keyJson);
			} catch (error) {
				throw new DriveError(
					ERROR_CODES.INVALID_KEY,
					`The service-account key is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					{ field: 'keyJson' },
				);
			}
			const key = assertServiceAccountKey(parsed);
			await this.repository.writeServiceKey(name, key);
			current.email = key.client_email;
			changed.push('key');
		}

		/* A rename moves the account and its credentials to the new name.
		 * The new name is written first, so a failure half-way leaves the
		 * old account intact rather than none at all. */
		let target = name;
		const requested = typeof payload?.newName === 'string' ? payload.newName.trim() : '';
		if (requested !== '' && requested !== name) {
			target = assertAccountName(requested);
			const taken = await this.repository.readAccount(target);
			const foreignTaken = taken ? null : (await this.foreignAccounts()).find((a) => a.name === target);
			if (taken || foreignTaken) {
				throw invalidInput(`An account named "${target}" already exists.`, { field: 'newName' });
			}
		}

		if (target !== name) {
			const loaded = await this.repository.loadSecret(current);
			if (loaded.status !== 'ready' || !loaded.secret) {
				throw invalidInput(
					`The credentials of "${name}" cannot be read, so it cannot be renamed. Add it again instead.`,
					{ field: 'newName', account: name },
				);
			}
			if (current.type === 'service_account') {
				await this.repository.writeServiceKey(target, loaded.secret.key);
			} else {
				await this.repository.writeOauthSecret(target, loaded.secret);
			}
			await this.repository.writeAccount({ ...current, name: target });
			await this.repository.removeAccount(name, new Set());
			changed.push('name');
		} else {
			await this.repository.writeAccount(current);
		}

		/* Everything the service remembers about the account was minted from
		 * the material that just changed. */
		this.forgetAccount(name);
		this.forgetAccount(target);
		await this.syncMirror();
		return { account: await this.describeAccount(target), renamed: target !== name, changed };
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
				// The account belongs to the Google Workspace MCP server. Its
				// key file can be shared with another account and the server may
				// still be using it, so its credentials are not this plugin's to
				// delete. Unlinking it is: the plugin stops offering it, and the
				// server keeps its own copy.
				await this.repository.hideAccount(name);
				this.tokenCache.delete(name);
				this.tokenRequests.delete(name);
				return {
					removed: true,
					unlinked: true,
					warnings: [
						`Unlinked "${name}" from this plugin. The Google Workspace MCP server keeps its credentials.`,
					],
				};
			}
			throw unknownAccount(name, await this.repository.listAccountNames());
		}
		const referenced = await this.mirror.referencedPaths([name]);
		const { kept } = await this.repository.removeAccount(name, referenced);
		this.forgetAccount(name);
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
	 * Read the plugin's own preferences.
	 *
	 * @returns {Promise<object>} the preferences.
	 */
	async getPreferences() {
		const preferences = await this.repository.readPreferences();
		return { sidebarTab: preferences.sidebarTab !== false };
	}

	/**
	 * Write the plugin's own preferences.
	 *
	 * @param {object} payload - the fields to change.
	 * @returns {Promise<object>} the preferences after the write.
	 */
	async setPreferences(payload) {
		const patch = {};
		if (typeof payload?.sidebarTab === 'boolean') patch.sidebarTab = payload.sidebarTab;
		const next = await this.repository.writePreferences(patch);
		return { sidebarTab: next.sidebarTab !== false };
	}

	/**
	 * Check that one account's credentials still work.
	 *
	 * The cheapest question Drive answers: can this account see its own root?
	 * A token that expired, a key file that moved and an account whose access
	 * was revoked all fail here, and each fails with its own message.
	 *
	 * @param {object} payload - the `accounts/test` payload.
	 * @param {AbortSignal} [payload.signal] - the caller's cancellation signal.
	 * @returns {Promise<{account: object, files: number}>} the result.
	 */
	async testAccount(payload, signal) {
		const name = assertAccountName(payload?.name);
		const account = await this.requireAccount(name);
		const result = await this.driveClient(account).listFiles({
			folderId: 'root',
			pageSize: 1,
			sharedRoot: GoogleDriveService.isSharedRootAccount(account),
			rootAlias: account.type === 'service_account' ? await this.rootFolderId(account) : null,
			signal,
		});
		return {
			account: {
				name,
				email: typeof account.email === 'string' ? account.email : null,
				type: account.type === 'service_account' ? 'service_account' : 'oauth',
				subject: typeof account.subject === 'string' ? account.subject : null,
			},
			files: Array.isArray(result.files) ? result.files.length : 0,
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
			// A service account sees the items shared with it at the top of
			// its Drive, and Drive reports those with no `parents` at all, so
			// the usual parent filter would show an empty folder.
			sharedRoot: GoogleDriveService.isSharedRootAccount(account),
			rootAlias: account.type === 'service_account' ? await this.rootFolderId(account) : null,
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
		let size = 0;
		try {
			size = (await stat(resolved)).size;
		} catch (error) {
			throw new DriveError(
				ERROR_CODES.IO,
				`Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
				{ path: resolved },
			);
		}
		if (size > MAX_DOWNLOAD_BYTES) {
			throw invalidInput(
				`${resolved} is ${size} bytes, which is more than the ${MAX_DOWNLOAD_BYTES} bytes this plugin uploads at once.`,
				{ field: 'localPath' },
			);
		}
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
		if (metadata) return this.withImpersonation(metadata);
		const foreign = await this.foreignAccount(accountName);
		if (foreign) return foreign;
		throw unknownAccount(accountName, await this.repository.listAccountNames());
	}

	/**
	 * Mark an account that acts as a Workspace user.
	 *
	 * A service account that names a subject impersonates that user, and an
	 * impersonated account has a real Drive root of its own rather than a pile
	 * of shared items.
	 *
	 * @param {object} metadata - the stored account metadata.
	 * @returns {object} the metadata with the flag.
	 */
	withImpersonation(metadata) {
		const subject = typeof metadata.subject === 'string' ? metadata.subject : '';
		return {
			...metadata,
			impersonating: metadata.type === 'service_account' && subject !== '',
		};
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
		const subject = typeof entry.subject === 'string' && entry.subject !== '' ? entry.subject : null;
		const metadata = {
			name,
			email: typeof entry.email === 'string' ? entry.email : null,
			type: serviceAccount ? 'service_account' : 'oauth',
			subject,
			// A service account that impersonates a Workspace user acts as that
			// user: it has a real Drive root of its own, not a pile of shared
			// items.
			impersonating: serviceAccount && subject !== null,
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
	 * The id of an account's own root folder.
	 *
	 * Drive answers `files.get('root')` with the account's "My Drive" id.
	 * A service account has one, and its own files hang off it, while the
	 * items shared with it carry no parent at all — both count as top level.
	 *
	 * @param {object} account - the account metadata.
	 * @returns {Promise<string|null>} the root folder id, or null when unknown.
	 */
	async rootFolderId(account) {
		const cached = this.rootIds.get(account.name);
		if (cached) return cached;
		try {
			const rootId = await this.driveClient(account).rootFolderId();
			if (rootId) this.rootIds.set(account.name, rootId);
			return rootId;
		} catch {
			// A root id is a refinement, not a requirement: the listing works
			// without it, so a failure here must not fail the request.
			return null;
		}
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
	 * Forget everything this service remembers about one account.
	 *
	 * The token cache holds a token minted from the credentials the account
	 * had, the probe cache holds the answer to "do those credentials work?"
	 * and the root id belongs to the Drive the account had. All three are
	 * wrong the moment the credentials change, so an account that is added,
	 * replaced or removed starts with a clean slate.
	 *
	 * @param {string} name - the account name.
	 */
	forgetAccount(name) {
		this.tokenCache.delete(name);
		this.tokenRequests.delete(name);
		this.probes.delete(name);
		this.rootIds.delete(name);
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
			// A plugin that owns no account has nothing to mirror. Writing
			// the shared file anyway would touch a file the plugin has no
			// business in, and could race with the program that owns it.
			if (entries.size === 0) {
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
			tokenPath: serviceAccount ? this.repository.mirrorKeyPath(name) : this.repository.tokenPath(name),
			addedAt: typeof metadata.addedAt === 'string' ? metadata.addedAt : new Date().toISOString(),
			kind: serviceAccount ? (metadata.subject ? 'service_account_impersonating' : 'service_account') : 'oauth',
		};
		if (typeof metadata.subject === 'string' && metadata.subject !== '') entry.subject = metadata.subject;
		if (!serviceAccount) entry.credentialsPath = this.repository.credentialPath(name);
		return entry;
	}

	/**
	 * Report what this machine can already supply.
	 *
	 * The probe never fails: a missing `gcloud` or an unreadable directory
	 * yields a partial answer, so the panel can always show what it found.
	 *
	 * @returns {Promise<object>} the contract's `onboarding/detect` payload.
	 */
	async detectOnboarding() {
		return await this.onboarding.detect();
	}

	/**
	 * Mint a new key for an existing service account.
	 *
	 * @param {object} payload - the `onboarding/create-service-key` payload.
	 * @param {string} payload.projectId - the project the account belongs to.
	 * @param {string} payload.serviceAccountEmail - the account to mint a key for.
	 * @returns {Promise<{key: object}>} the contract's `onboarding/create-service-key` payload.
	 */
	async createServiceKey(payload) {
		return await this.onboarding.createServiceKey({
			projectId: payload?.projectId,
			serviceAccountEmail: payload?.serviceAccountEmail,
		});
	}

	/** Release every resource this service holds. */
	dispose() {
		this.flows.dispose();
		this.onboarding.dispose();
		this.tokenCache.clear();
		this.rootIds.clear();
		this.tokenRequests.clear();
	}
}
