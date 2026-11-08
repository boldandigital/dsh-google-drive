/**
 * The compatibility bridge to `google-workspace-mcp`.
 *
 * The upstream MCP server reads its accounts from `~/.google-mcp/accounts.json`
 * and re-reads that file on every call, so a mirror is enough for an
 * installed server to pick an account up without a restart. The mirror is
 * strictly best effort: a failure to write it is reported as a warning and
 * never fails the operation that triggered it.
 *
 * Two rules keep the mirror from destroying somebody else's work:
 *
 * 1. Entries this plugin did not write are preserved. The upstream file is
 *    shared with accounts the user added through the MCP server itself, and
 *    removing them would silently disable them.
 * 2. Only files under this plugin's own directories are ever removed. The
 *    upstream server unlinks the file an account points at, which for a
 *    service account is the private key — and two accounts can share one key
 *    file, so removing one account there breaks the other.
 */

import path from 'node:path';

import { readJsonFile, writeJsonFile } from './files.js';

/**
 * Read and write the shared account file the upstream MCP server reads.
 */
export class McpMirror {
	/**
	 * @param {object} options - resolved plugin options.
	 * @param {import('./repository.js').AccountRepository} repository - the account repository.
	 */
	constructor(options, repository) {
		this.options = options;
		this.repository = repository;
		this.accountsPath = path.join(options.storeDir, 'accounts.json');
		this.queue = Promise.resolve();
	}

	/**
	 * Run one mutation under the mirror's lock.
	 *
	 * Two rapid add/remove calls would otherwise interleave their read and
	 * write of the shared file and drop one of the two accounts.
	 *
	 * @template T
	 * @param {() => Promise<T>} task - the mutation to run exclusively.
	 * @returns {Promise<T>} the task's result.
	 */
	withLock(task) {
		const run = this.queue.then(task, task);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Whether a path belongs to this plugin's private directories.
	 *
	 * @param {string} file - an absolute path.
	 * @returns {boolean} true when the file is one this plugin wrote.
	 */
	isManagedPath(file) {
		if (typeof file !== 'string' || file === '') return false;
		const roots = [
			this.repository.tokenDir,
			this.repository.keyDir,
			this.repository.credentialDir,
			this.repository.metaDir,
		];
		return roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
	}

	/**
	 * Read the shared account file.
	 *
	 * @returns {Promise<{accounts: object, credentialsPath: string|null}>} its content.
	 */
	async read() {
		const raw = await readJsonFile(this.accountsPath);
		const accounts = raw && typeof raw === 'object' && raw.accounts && typeof raw.accounts === 'object'
			? raw.accounts
			: {};
		return {
			accounts,
			credentialsPath: typeof raw?.credentialsPath === 'string' ? raw.credentialsPath : null,
		};
	}

	/**
	 * Replace this plugin's accounts in the shared file, keeping the others.
	 *
	 * An account this plugin removed disappears from the file because its
	 * token path is one of ours and it is no longer in `entries`; an account
	 * the user added through the MCP server keeps its entry.
	 *
	 * @param {Map<string, object>} entries - the accounts this plugin manages.
	 * @returns {Promise<object>} the file content that was written.
	 */
	async writeAccounts(entries) {
		return this.withLock(async () => {
			const current = await this.read();
			const accounts = { ...current.accounts };
			for (const [name, entry] of Object.entries(accounts)) {
				if (!entries.has(name) && this.isManagedPath(entry?.tokenPath)) delete accounts[name];
			}
			for (const [name, entry] of entries) accounts[name] = entry;
			const next = {
				accounts,
				credentialsPath:
					current.credentialsPath ?? path.join(this.options.storeDir, 'credentials.json'),
			};
			await writeJsonFile(this.accountsPath, next, 0o600);
			return next;
		});
	}

	/**
	 * Every path another account still points at.
	 *
	 * @param {string[]} except - account names to ignore.
	 * @returns {Promise<Set<string>>} the referenced absolute paths.
	 */
	async referencedPaths(except = []) {
		const current = await this.read();
		const paths = new Set();
		for (const [name, entry] of Object.entries(current.accounts)) {
			if (except.includes(name)) continue;
			if (typeof entry?.tokenPath === 'string' && entry.tokenPath !== '') paths.add(entry.tokenPath);
		}
		return paths;
	}
}
