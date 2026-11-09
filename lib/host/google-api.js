/**
 * The Google authentication endpoints this plugin speaks.
 *
 * Everything is plain `fetch` against the documented REST endpoints: no
 * googleapis dependency, so the bundle stays free of npm packages and the
 * account formats stay readable. Access tokens are held in memory only; the
 * refresh token and the service-account key are what get stored.
 */

import { createSign } from 'node:crypto';

import { DriveError, ERROR_CODES } from './errors.js';

/** Where the user sends the browser to authorize this plugin. */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Where authorization codes and refresh tokens are exchanged for access tokens. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Where the signed-in user's identity is read. */
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** The audience a service-account assertion must be signed for. */
export const GOOGLE_JWT_AUDIENCE = 'https://oauth2.googleapis.com/token';

/** The grant type that trades a signed assertion for an access token. */
export const SERVICE_ACCOUNT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Every Google request gives up after this long. */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Escape one value for use inside a Drive query string literal.
 *
 * Drive queries quote strings with single quotes and escape a backslash by
 * doubling it, so a name like `Bob's "old" drive` would otherwise end the
 * literal early and corrupt the whole query.
 *
 * @param {unknown} value - the raw user input.
 * @returns {string} the escaped value, without the surrounding quotes.
 */
export function escapeDriveQueryValue(value) {
	return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Encode bytes as base64url without padding.
 *
 * @param {Buffer|string} input - the bytes to encode.
 * @returns {string} the base64url text.
 */
export function base64url(input) {
	return Buffer.from(input).toString('base64url');
}

/**
 * Sign the JWT assertion a service account exchanges for an access token.
 *
 * The assertion is short lived and never leaves the process except inside
 * the token request; the private key itself is only used to sign.
 *
 * @param {object} options - the assertion inputs.
 * @param {string} options.clientEmail - the service account's address.
 * @param {string} options.privateKey - the PEM private key.
 * @param {string[]} options.scopes - the scopes to request.
 * @param {string} [options.subject] - the Workspace user to impersonate.
 * @param {number} [options.now] - the current time in milliseconds.
 * @param {number} [options.lifetimeSeconds] - how long the assertion is valid.
 * @returns {string} the signed JWT.
 */
export function signJwtAssertion({ clientEmail, privateKey, scopes, subject, now = Date.now(), lifetimeSeconds = 3600 }) {
	const issuedAt = Math.floor(now / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const claims = {
		iss: clientEmail,
		scope: scopes.join(' '),
		aud: GOOGLE_JWT_AUDIENCE,
		exp: issuedAt + lifetimeSeconds,
		iat: issuedAt,
	};
	// Domain-wide delegation is a `sub` claim and nothing else; without it the
	// token belongs to the service account itself.
	if (subject) claims.sub = subject;
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
	const signer = createSign('RSA-SHA256');
	signer.update(signingInput);
	signer.end();
	return `${signingInput}.${base64url(signer.sign(privateKey))}`;
}

/**
 * Read the error out of a Google error payload.
 *
 * @param {unknown} payload - the parsed response body.
 * @returns {{error: string, description: string}} the error and its description.
 */
export function readGoogleError(payload) {
	if (!payload || typeof payload !== 'object') return { error: 'unknown', description: '' };
	const error = typeof payload.error === 'string' ? payload.error : 'unknown';
	const description =
		typeof payload.error_description === 'string'
			? payload.error_description
			: typeof payload.error_description === 'object' && payload.error_description !== null
				? JSON.stringify(payload.error_description).slice(0, 400)
				: '';
	return { error, description };
}

/**
 * The Google endpoints this plugin talks to.
 */
export class GoogleAuthClient {
	/**
	 * @param {object} [dependencies] - injectable dependencies for tests.
	 * @param {typeof fetch} [dependencies.fetchImpl] - the fetch implementation.
	 */
	constructor(dependencies = {}) {
		this.fetch = dependencies.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
	}

	/**
	 * Perform one request and parse its JSON body.
	 *
	 * @param {string} url - the target URL.
	 * @param {object} init - the fetch init.
	 * @param {AbortSignal} [signal] - the caller's cancellation signal.
	 * @returns {Promise<{ok: boolean, status: number, payload: object}>} the response and its body.
	 */
	async requestJson(url, init, signal) {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response;
		try {
			response = await this.fetch(url, { ...init, signal: combined });
		} catch (error) {
			throw new DriveError(
				ERROR_CODES.OAUTH_FAILED,
				`Could not reach Google (${error instanceof Error ? error.message : String(error)}). Check the network and try again.`,
				{ url },
			);
		}
		let payload = {};
		try {
			payload = await response.json();
		} catch {
			payload = {};
		}
		return { ok: response.ok, status: response.status, payload };
	}

	/**
	 * Exchange an authorization code for tokens.
	 *
	 * @param {object} options - the exchange inputs.
	 * @param {string} options.code - the authorization code.
	 * @param {string} options.codeVerifier - the PKCE verifier.
	 * @param {string} options.clientId - the OAuth client id.
	 * @param {string} options.clientSecret - the OAuth client secret.
	 * @param {string} options.redirectUri - the redirect URI the code was issued for.
	 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>} the tokens.
	 */
	async exchangeAuthorizationCode({ code, codeVerifier, clientId, clientSecret, redirectUri }) {
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			code_verifier: codeVerifier,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
		});
		const { ok, payload } = await this.requestJson(
			GOOGLE_TOKEN_URL,
			{ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
		);
		if (!ok) {
			const { error, description } = readGoogleError(payload);
			throw new DriveError(
				ERROR_CODES.OAUTH_FAILED,
				`Google refused the authorization code (${error}).${description ? ` ${description}` : ''} Check the client id and secret, then start the sign-in again.`,
				{ reason: error },
			);
		}
		if (typeof payload.access_token !== 'string' || payload.access_token === '') {
			throw new DriveError(ERROR_CODES.OAUTH_FAILED, 'Google returned no access token for this authorization.', {});
		}
		return {
			accessToken: payload.access_token,
			refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
			expiresIn: Number.isFinite(payload.expires_in) ? payload.expires_in : 3600,
			scope: typeof payload.scope === 'string' ? payload.scope : '',
		};
	}

	/**
	 * Exchange a refresh token for a fresh access token.
	 *
	 * @param {object} options - the refresh inputs.
	 * @param {string} options.refreshToken - the stored refresh token.
	 * @param {string} options.clientId - the OAuth client id.
	 * @param {string} options.clientSecret - the OAuth client secret.
	 * @returns {Promise<{accessToken: string, expiresIn: number}>} the new access token.
	 */
	async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
		});
		const { ok, payload } = await this.requestJson(
			GOOGLE_TOKEN_URL,
			{ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
		);
		if (!ok) {
			const { error, description } = readGoogleError(payload);
			throw new DriveError(
				ERROR_CODES.OAUTH_FAILED,
				`Google refused to refresh the access token (${error}).${description ? ` ${description}` : ''} Sign the account in again to grant a new one.`,
				{ reason: error },
			);
		}
		if (typeof payload.access_token !== 'string' || payload.access_token === '') {
			throw new DriveError(ERROR_CODES.OAUTH_FAILED, 'Google returned no access token for this refresh.', {});
		}
		return {
			accessToken: payload.access_token,
			expiresIn: Number.isFinite(payload.expires_in) ? payload.expires_in : 3600,
		};
	}

	/**
	 * Trade a signed assertion for a service-account access token.
	 *
	 * @param {object} options - the assertion inputs.
	 * @param {object} options.key - the service-account key.
	 * @param {string[]} options.scopes - the scopes to request.
	 * @param {string} [options.subject] - the Workspace user to impersonate.
	 * @returns {Promise<{accessToken: string, expiresIn: number}>} the access token.
	 */
	async serviceAccountAccessToken({ key, scopes, subject }) {
		let assertion;
		try {
			assertion = signJwtAssertion({
				clientEmail: key.client_email,
				privateKey: key.private_key,
				scopes,
				subject,
			});
		} catch (error) {
			throw new DriveError(
				ERROR_CODES.INVALID_KEY,
				`The service-account key could not be used to sign a token: ${error instanceof Error ? error.message : String(error)}`,
				{ field: 'keyJson' },
			);
		}
		const body = new URLSearchParams({ grant_type: SERVICE_ACCOUNT_GRANT, assertion });
		const { ok, payload } = await this.requestJson(
			GOOGLE_TOKEN_URL,
			{ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
		);
		if (!ok) {
			const { error, description } = readGoogleError(payload);
			/* A refused impersonation is a missing administrator action, not
			 * a broken key: the message therefore names the client id and
			 * the scope that have to be authorized, and where to do it. */
			const needsDelegation =
				subject && ['unauthorized_client', 'access_denied', 'invalid_grant'].includes(error);
			const clientId = typeof key.client_id === 'string' && key.client_id !== '' ? key.client_id : null;
			const delegation = needsDelegation
				? ` A Workspace administrator must authorize this service account's client id for domain-wide delegation` +
					`${clientId ? ` (${clientId})` : ''}, together with the scope${scopes.length === 1 ? '' : 's'} ` +
					`${scopes.join(', ') || 'the one this plugin requests'}.` +
					' In the Google Admin console: Security → API access → Domain-wide delegation → Add new,' +
					' then paste the client id and authorize the scope.' +
					' The subject must also be a user in that Workspace.'
				: '';
			throw new DriveError(
				ERROR_CODES.OAUTH_FAILED,
				`Google refused the service-account token (${error}).${description ? ` ${description}` : ''}${delegation}`,
				{ reason: error, subject: subject ?? null, clientId, scopes: [...scopes] },
			);
		}
		if (typeof payload.access_token !== 'string' || payload.access_token === '') {
			throw new DriveError(ERROR_CODES.OAUTH_FAILED, 'Google returned no access token for this service account.', {});
		}
		return {
			accessToken: payload.access_token,
			expiresIn: Number.isFinite(payload.expires_in) ? payload.expires_in : 3600,
		};
	}

	/**
	 * Read the signed-in user's email address.
	 *
	 * Best effort: the address is nice to have in the account list, but a
	 * failure here must not fail a sign-in that already succeeded.
	 *
	 * @param {string} accessToken - the access token.
	 * @returns {Promise<string|null>} the email address, or null.
	 */
	async fetchUserEmail(accessToken) {
		try {
			const { ok, payload } = await this.requestJson(GOOGLE_USERINFO_URL, {
				method: 'GET',
				headers: { authorization: `Bearer ${accessToken}` },
			});
			if (!ok) return null;
			return typeof payload.email === 'string' ? payload.email : null;
		} catch {
			return null;
		}
	}
}
