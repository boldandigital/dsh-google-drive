/**
 * The credential seam.
 *
 * The credential service is the authoritative store for every secret this
 * plugin holds: `modifyRecord` is the only write path, so a record is always
 * written under an exclusive lock. The service is optional though — a profile
 * without the credentials plugin still gets a working account manager, backed
 * by the private files in the compatibility store, and every result says so.
 */

import { assertCredentialKey } from './names.js';

/**
 * Find the credential service on a plugin context.
 *
 * @param {object} ctx - the plugin context.
 * @returns {object|null} the service, or null when this profile has none.
 */
function resolveCredentialsService(ctx) {
	try {
		const direct = ctx?.credentials;
		if (direct && typeof direct.modifyRecord === 'function') return direct;
	} catch {
		// A context that cannot resolve the service is treated as "no service".
	}
	try {
		const resolved = typeof ctx?.get === 'function' ? ctx.get('credentials') : null;
		if (resolved && typeof resolved.modifyRecord === 'function') return resolved;
	} catch {
		// Same: a missing service is a supported configuration, not an error.
	}
	return null;
}

/**
 * Read and write credential records for this plugin.
 */
export class SecretStore {
	/**
	 * @param {object} ctx - the plugin context.
	 */
	constructor(ctx) {
		this.service = resolveCredentialsService(ctx);
	}

	/** Whether the credential service is mounted in this profile. */
	get available() {
		return this.service !== null;
	}

	/**
	 * Read one record.
	 *
	 * @param {string} key - the record key.
	 * @returns {Promise<object|undefined>} the record, or undefined when absent.
	 */
	async readRecord(key) {
		if (!this.service) return undefined;
		try {
			return await this.service.readRecord(key);
		} catch {
			// A record that cannot be read is treated as absent; the caller
			// falls back to the file mirror and reports the degraded mode.
			return undefined;
		}
	}

	/**
	 * Write one record.
	 *
	 * @param {string} key - the record key; must be addressable by the store.
	 * @param {object} payload - the JSON payload; must survive a round trip.
	 * @returns {Promise<boolean>} true when the record was written.
	 */
	async writeRecord(key, payload) {
		assertCredentialKey(key);
		if (!this.service) return false;
		await this.service.modifyRecord(key, async () => ({ kind: 'grant', payload }));
		return true;
	}

	/**
	 * Remove one record.
	 *
	 * @param {string} key - the record key.
	 * @returns {Promise<boolean>} true when a removal was attempted.
	 */
	async deleteRecord(key) {
		if (!this.service) return false;
		try {
			await this.service.deleteRecord(key);
		} catch {
			// A record that cannot be removed is reported by the next listing.
		}
		return true;
	}

	/**
	 * List the keys this plugin owns.
	 *
	 * @returns {Promise<string[]>} the record keys currently stored.
	 */
	async listRecordKeys() {
		if (!this.service || typeof this.service.listRecords !== 'function') return [];
		let records;
		try {
			records = await this.service.listRecords();
		} catch {
			return [];
		}
		return (Array.isArray(records) ? records : [])
			.map((record) => (record && typeof record.key === 'string' ? record.key : null))
			.filter((key) => key !== null);
	}
}
