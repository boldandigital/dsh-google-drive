/**
 * The error vocabulary the contract defines.
 *
 * Every failure that reaches the client carries one of these codes, a message
 * a user can act on, and an always-object `details` bag. Nothing is swallowed:
 * an unexpected throw is reported as `internal` with its message rather than
 * being turned into a silent empty result.
 */

/** Error codes the contract fixes. */
export const ERROR_CODES = {
	/** Rejected input: a malformed key, or a request field that failed validation. */
	INVALID_KEY: 'invalid-key',
	/** The named account does not exist in this plugin. */
	UNKNOWN_ACCOUNT: 'unknown-account',
	/** The RPC method named an endpoint this plugin does not serve. */
	UNKNOWN_ENDPOINT: 'unknown-endpoint',
	/** An OAuth or token exchange failed. */
	OAUTH_FAILED: 'oauth-failed',
	/** Google Drive rejected a request. */
	DRIVE_API: 'drive-api',
	/** A file on disk could not be read or written. */
	IO: 'io',
	/** Anything unexpected. */
	INTERNAL: 'internal',
};

/**
 * A failure that already knows which contract code it reports.
 *
 * Carrying the code on the error keeps the mapping in one place: the RPC
 * layer and the tool layer both turn a `DriveError` into the same payload.
 */
export class DriveError extends Error {
	/**
	 * @param {string} code - one of {@link ERROR_CODES}.
	 * @param {string} message - a message the user can act on.
	 * @param {object} [details] - machine-readable context; never null.
	 */
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'DriveError';
		this.code = code;
		this.details = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
	}
}

/**
 * Reject an invalid input.
 *
 * The contract's code list has no separate "bad request" code, so every
 * rejected field reports `invalid-key` and names the offending field in
 * `details.field`; the client half can therefore treat one code as "the
 * request or its key material is invalid".
 *
 * @param {string} message - what was wrong, in the user's terms.
 * @param {object} [details] - extra context, e.g. `{ field: 'name' }`.
 * @returns {DriveError} the error to throw.
 */
export function invalidInput(message, details = {}) {
	return new DriveError(ERROR_CODES.INVALID_KEY, message, details);
}

/**
 * Report an unknown account by name.
 *
 * @param {string} name - the account the caller named.
 * @param {string[]} [available] - the account names that do exist.
 * @returns {DriveError} the error to throw.
 */
export function unknownAccount(name, available = []) {
	const hint = available.length > 0 ? ` Available accounts: ${available.join(', ')}.` : ' No accounts are configured.';
	return new DriveError(
		ERROR_CODES.UNKNOWN_ACCOUNT,
		`No Google Drive account named "${name}".${hint}`,
		{ account: name, available },
	);
}

/**
 * Turn any thrown value into the contract's error payload.
 *
 * Node filesystem errors carry a `code` such as `ENOENT`; those are reported
 * as `io` rather than as an internal bug, because the user can act on them.
 *
 * @param {unknown} error - the thrown value.
 * @returns {{code: string, message: string, details: object}} the payload.
 */
export function toErrorPayload(error) {
	if (error instanceof DriveError) {
		return { code: error.code, message: error.message, details: error.details };
	}
	if (error && typeof error === 'object' && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
		return {
			code: ERROR_CODES.IO,
			message: `File operation failed (${error.code}): ${error instanceof Error ? error.message : String(error)}`,
			details: { syscall: error.syscall ?? null },
		};
	}
	return {
		code: ERROR_CODES.INTERNAL,
		message: error instanceof Error ? error.message : String(error),
		details: {},
	};
}
