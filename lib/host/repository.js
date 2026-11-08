/**
 * The account repository.
 *
 * An account is described by metadata (no secret) and backed by exactly one
 * kind of secret: an OAuth refresh token, or a service-account key. The
 * credential service holds both; the private files under the compatibility
 * store hold the same material in the format the upstream MCP server reads,
 * and act as the fallback when no credential service is mounted.
 *
 * Every service account gets its own copy of the key file. The upstream
 * server deletes the file an account points at when that account is removed,
 * and two accounts on one machine can share one key file — so pointing at a
 * file the user pasted somewhere else would let one removal destroy the other
 * account. A copy this plugin made can only ever be this account's own.
 */

import path from 'node:path';

import { ensureDir, listJsonFiles, readJsonFile, removeFile, writeJsonFile } from './files.js';
import { accountNameFromRecordKey, recordKeys } from './names.js';

/**
 * Read and write account metadata and the secrets behind it.
 */
export class AccountRepository {
	/**
	 * @param {object} options - resolved plugin options.
	 * @param {import('./credentials.js').SecretStore} store - the credential seam.
	 */
	constructor(options, store) {
		this.options = options;
		this.store = store;
		// The private files live in a directory of this plugin's own. The
		// upstream MCP server keeps its OAuth tokens in `<storeDir>/tokens`
		// and its client secrets in `<storeDir>/credentials`; sharing those
		// directories would let this plugin's cleanup touch files the server
		// owns, and would let a name collision overwrite a token the server
		// still needs.
		this.privateDir = path.join(options.storeDir, 'dsh-google-drive');
		this.metaDir = path.join(this.privateDir, 'meta');
		this.tokenDir = path.join(this.privateDir, 'tokens');
		this.keyDir = path.join(this.privateDir, 'keys');
		this.credentialDir = path.join(this.privateDir, 'credentials');
		this.hiddenPath = path.join(this.privateDir, 'hidden.json');
		this.preferencesPath = path.join(this.privateDir, 'preferences.json');
	}

	/**
	 * Read the plugin's own preferences.
	 *
	 * These are the settings the user toggles in the plugin's Settings
	 * section. They live in the plugin's own directory, so they travel with
	 * the plugin and not with the harness's configuration.
	 *
	 * @returns {Promise<object>} the preferences.
	 */
	async readPreferences() {
		const payload = await readJsonFile(this.preferencesPath);
		return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
	}

	/**
	 * Write the plugin's own preferences.
	 *
	 * @param {object} patch - the fields to change.
	 * @returns {Promise<object>} the preferences after the write.
	 */
	async writePreferences(patch) {
		const next = { ...(await this.readPreferences()), ...(patch || {}) };
		await ensureDir(this.privateDir, 0o700);
		await writeJsonFile(this.preferencesPath, next, 0o600);
		return next;
	}

	/**
	 * Read the accounts this plugin must ignore.
	 *
	 * An account the upstream MCP server owns cannot be deleted from here:
	 * its key file can be shared with another account and the server may
	 * still be using it. It can, though, be unlinked — hidden from this
	 * plugin while the server keeps its own copy. The names live in one
	 * file of this plugin's own directory.
	 *
	 * @returns {Promise<string[]>} the hidden names.
	 */
	async listHiddenAccounts() {
		const payload = await readJsonFile(this.hiddenPath);
		const names = payload && Array.isArray(payload.accounts) ? payload.accounts : [];
		return names.filter((name) => typeof name === 'string' && name !== '');
	}

	/**
	 * Hide one account from this plugin.
	 *
	 * @param {string} name - the account name.
	 * @returns {Promise<void>} nothing.
	 */
	async hideAccount(name) {
		const hidden = new Set(await this.listHiddenAccounts());
		hidden.add(name);
		await ensureDir(this.privateDir, 0o700);
		await writeJsonFile(this.hiddenPath, { accounts: [...hidden].sort() }, 0o600);
	}

	/** Where the metadata of one account lives. */
	metaPath(name) {
		return path.join(this.metaDir, `${name}.json`);
	}

	/** Where the OAuth token of one account lives (upstream format). */
	tokenPath(name) {
		return path.join(this.tokenDir, `${name}.json`);
	}

	/** Where the private copy of one service-account key lives. */
	keyPath(name) {
		return path.join(this.keyDir, `${name}.json`);
	}

	/** Where the OAuth client of one account lives (upstream format). */
	credentialPath(name) {
		return path.join(this.credentialDir, `${name}.json`);
	}

	/**
	 * List every account name this plugin knows about.
	 *
	 * @returns {Promise<string[]>} the names, sorted.
	 */
	async listAccountNames() {
		const names = new Set();
		for (const key of await this.store.listRecordKeys()) {
			const name = accountNameFromRecordKey(key);
			if (name) names.add(name);
		}
		for (const file of await listJsonFiles(this.metaDir)) {
			names.add(file.replace(/\.json$/, ''));
		}
		return [...names].sort();
	}

	/**
	 * Read the metadata of one account.
	 *
	 * @param {string} name - the account name.
	 * @returns {Promise<object|null>} the metadata, or null when unknown.
	 */
	async readAccount(name) {
		const record = await this.store.readRecord(recordKeys(name).account);
		const payload = record && typeof record === 'object' && record.payload && typeof record.payload === 'object'
			? record.payload
			: null;
		const fromFile = payload ? null : await readJsonFile(this.metaPath(name));
		const metadata = payload ?? fromFile;
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
		return { ...metadata, name };
	}

	/**
	 * Whether this plugin owns an account.
	 *
	 * An account the upstream MCP server added is not this plugin's to
	 * remove: its key file may be shared with another account, and the server
	 * that owns it may still be using it.
	 *
	 * @param {string} name - the account name.
	 * @returns {Promise<boolean>} true when the plugin manages the account.
	 */
	async ownsAccount(name) {
		return (await this.readAccount(name)) !== null;
	}

	/**
	 * Write the metadata of one account to both stores.
	 *
	 * @param {object} metadata - the account metadata.
	 * @returns {Promise<void>} resolves once both stores are written.
	 */
	async writeAccount(metadata) {
		await ensureDir(this.metaDir, 0o700);
		await this.store.writeRecord(recordKeys(metadata.name).account, metadata);
		await writeJsonFile(this.metaPath(metadata.name), metadata, 0o600);
	}

	/**
	 * Store the OAuth material of one account.
	 *
	 * @param {string} name - the account name.
	 * @param {{clientId: string, clientSecret: string, refreshToken: string}} secret - the OAuth material.
	 * @returns {Promise<void>} resolves once both stores are written.
	 */
	async writeOauthSecret(name, secret) {
		await this.store.writeRecord(recordKeys(name).oauthClient, {
			clientId: secret.clientId,
			clientSecret: secret.clientSecret,
		});
		await this.store.writeRecord(recordKeys(name).refreshToken, { refreshToken: secret.refreshToken });
		// The upstream server reads the client from a credentials file and the
		// refresh token from a token file; both are written so the account
		// works there without a restart.
		await writeJsonFile(
			this.tokenPath(name),
			{
				type: 'authorized_user',
				client_id: secret.clientId,
				client_secret: secret.clientSecret,
				refresh_token: secret.refreshToken,
			},
			0o600,
		);
		await writeJsonFile(
			this.credentialPath(name),
			{
				installed: {
					client_id: secret.clientId,
					client_secret: secret.clientSecret,
					redirect_uris: ['http://localhost:3000'],
				},
			},
			0o600,
		);
	}

	/**
	 * Store the key of one service account.
	 *
	 * @param {string} name - the account name.
	 * @param {object} key - the service-account key, as the user pasted it.
	 * @returns {Promise<void>} resolves once both stores are written.
	 */
	async writeServiceKey(name, key) {
		await this.store.writeRecord(recordKeys(name).serviceKey, key);
		await writeJsonFile(this.keyPath(name), key, 0o600);
	}

	/**
	 * Load the secret behind one account and say whether the account is
	 * usable, broken, or simply not probed yet.
	 *
	 * The three states differ for the user: `ready` works, `error` has
	 * material that cannot be used (a truncated key file, a revoked refresh
	 * token) and `unknown` has no material at all yet.
	 *
	 * @param {object} metadata - the account metadata.
	 * @returns {Promise<{status: string, secret: object|null}>} the state and the secret.
	 */
	async loadSecret(metadata) {
		if (!metadata || typeof metadata !== 'object') return { status: 'unknown', secret: null };
		if (metadata.type === 'service_account') {
			const record = await this.store.readRecord(recordKeys(metadata.name).serviceKey);
			const fromRecord = record && typeof record === 'object' && record.payload && typeof record.payload === 'object'
				? record.payload
				: null;
			const fromFile = fromRecord ? null : await readJsonFile(this.keyPath(metadata.name));
			const key = fromRecord ?? fromFile;
			if (!key) return { status: 'unknown', secret: null };
			if (typeof key !== 'object' || typeof key.private_key !== 'string' || key.private_key === '') {
				return { status: 'error', secret: null };
			}
			return { status: 'ready', secret: { key } };
		}
		const clientRecord = await this.store.readRecord(recordKeys(metadata.name).oauthClient);
		const clientPayload =
			clientRecord && typeof clientRecord === 'object' && clientRecord.payload && typeof clientRecord.payload === 'object'
				? clientRecord.payload
				: null;
		const refreshRecord = await this.store.readRecord(recordKeys(metadata.name).refreshToken);
		const refreshPayload =
			refreshRecord && typeof refreshRecord === 'object' && refreshRecord.payload && typeof refreshRecord.payload === 'object'
				? refreshRecord.payload
				: null;
		const tokenFile = await readJsonFile(this.tokenPath(metadata.name));
		if (!clientPayload && !refreshPayload && !tokenFile) return { status: 'unknown', secret: null };
		const clientId = clientPayload?.clientId ?? tokenFile?.client_id ?? null;
		const clientSecret = clientPayload?.clientSecret ?? tokenFile?.client_secret ?? null;
		const refreshToken = refreshPayload?.refreshToken ?? tokenFile?.refresh_token ?? null;
		if (typeof clientId !== 'string' || typeof clientSecret !== 'string' || typeof refreshToken !== 'string') {
			return { status: 'error', secret: null };
		}
		return { status: 'ready', secret: { clientId, clientSecret, refreshToken } };
	}

	/**
	 * Remove every trace of one account.
	 *
	 * Only files this plugin created are removed, and only when no other
	 * account still points at them.
	 *
	 * @param {string} name - the account name.
	 * @param {Set<string>} referenced - absolute paths other accounts still use.
	 * @returns {Promise<{removed: string[], kept: string[]}>} which files went and which stayed.
	 */
	async removeAccount(name, referenced = new Set()) {
		const keys = recordKeys(name);
		await this.store.deleteRecord(keys.account);
		await this.store.deleteRecord(keys.oauthClient);
		await this.store.deleteRecord(keys.refreshToken);
		await this.store.deleteRecord(keys.serviceKey);
		const removed = [];
		const kept = [];
		for (const file of [this.metaPath(name), this.tokenPath(name), this.keyPath(name), this.credentialPath(name)]) {
			if (referenced.has(file)) {
				kept.push(file);
				continue;
			}
			const gone = await removeFile(file);
			if (gone) removed.push(file);
			else kept.push(file);
		}
		return { removed, kept };
	}
}
