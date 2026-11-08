/**
 * Account names and the credential-record keys that address them.
 *
 * The DSH credential store addresses a record as `<scope>/<id>` where every
 * segment must match `^[a-z][a-z0-9-]*$`. The contract's keys read
 * `google-drive/account/<name>`, which has three segments and an account name
 * that may contain uppercase letters and underscores — the store rejects both
 * and an unreadable credentials document fails the whole credentials plugin
 * at boot. So the keys are built as `<scope>/<concern>-<encoded name>`, with
 * the name encoded into the lowercase alphabet the store accepts.
 */

import { invalidInput } from './errors.js';

/** The account name grammar the contract fixes. */
export const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** The credential-key grammar the credential store enforces on both segments. */
export const CREDENTIAL_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** The scope this plugin owns inside the credential store. */
export const CREDENTIAL_SCOPE = 'google-drive';

/**
 * Check an account name against the contract's grammar.
 *
 * @param {unknown} name - the candidate name.
 * @returns {string} the name, trimmed.
 * @throws {DriveError} `invalid-key` when the name is empty or malformed.
 */
export function assertAccountName(name) {
	if (typeof name !== 'string') {
		throw invalidInput('An account name is required.', { field: 'name' });
	}
	const trimmed = name.trim();
	if (trimmed === '') {
		throw invalidInput('An account name is required.', { field: 'name' });
	}
	if (!ACCOUNT_NAME_PATTERN.test(trimmed)) {
		throw invalidInput(
			'Account names may only contain letters, digits, underscores and hyphens.',
			{ field: 'name', value: trimmed },
		);
	}
	if (trimmed.length > 64) {
		throw invalidInput('Account names may be at most 64 characters long.', { field: 'name' });
	}
	return trimmed;
}

/**
 * Encode an account name into the lowercase alphabet a credential key allows.
 *
 * Every character outside `[a-z0-9]` becomes `-<hex>-`, so the encoding is
 * reversible and two different names never collide (`A` and `-41-` differ).
 *
 * @param {string} name - a validated account name.
 * @returns {string} the encoded segment.
 */
export function encodeNameSegment(name) {
	let out = '';
	for (const char of String(name)) {
		if (/[a-z0-9]/.test(char)) {
			out += char;
			continue;
		}
		out += `-${char.codePointAt(0).toString(16).padStart(2, '0')}-`;
	}
	return out;
}

/**
 * Decode a segment produced by {@link encodeNameSegment}.
 *
 * @param {string} segment - the encoded segment.
 * @returns {string} the original name.
 */
export function decodeNameSegment(segment) {
	return String(segment).replace(/-([0-9a-f]{2})-/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Build the credential-record keys this plugin owns.
 *
 * @param {string} name - a validated account name.
 * @returns {{account: string, oauthClient: string, refreshToken: string, serviceKey: string}} the four keys.
 */
export function recordKeys(name) {
	const segment = encodeNameSegment(name);
	return {
		account: `${CREDENTIAL_SCOPE}/account-${segment}`,
		oauthClient: `${CREDENTIAL_SCOPE}/oauth-client-${segment}`,
		refreshToken: `${CREDENTIAL_SCOPE}/refresh-token-${segment}`,
		serviceKey: `${CREDENTIAL_SCOPE}/service-key-${segment}`,
	};
}

/**
 * Check that a key can be written to the credential store at all.
 *
 * A key outside the store's grammar is stored happily and only fails later,
 * when the whole credentials document can no longer be parsed. Refusing it
 * here keeps one bad key from taking the credential service down.
 *
 * @param {string} key - the candidate record key.
 * @returns {string} the key.
 * @throws {DriveError} `invalid-key` when the key cannot be addressed.
 */
export function assertCredentialKey(key) {
	if (typeof key !== 'string' || !CREDENTIAL_KEY_PATTERN.test(key)) {
		throw invalidInput(`Credential key "${String(key)}" cannot be addressed by the credential store.`, {
			field: 'key',
			value: String(key),
		});
	}
	return key;
}

/**
 * Recover an account name from one of this plugin's record keys.
 *
 * @param {string} key - a credential-record key.
 * @returns {string|null} the account name, or null when the key is not ours.
 */
export function accountNameFromRecordKey(key) {
	if (typeof key !== 'string') return null;
	const prefix = `${CREDENTIAL_SCOPE}/`;
	if (!key.startsWith(prefix)) return null;
	const rest = key.slice(prefix.length);
	// The concern names themselves contain hyphens, so each one is matched by
	// prefix rather than by splitting on the first hyphen.
	for (const concern of ['oauth-client', 'refresh-token', 'service-key', 'account']) {
		if (rest.startsWith(`${concern}-`)) return decodeNameSegment(rest.slice(concern.length + 1));
	}
	return null;
}
