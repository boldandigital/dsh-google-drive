/**
 * Small file helpers used by the account store.
 *
 * Every secret-bearing file is created with mode 0600 inside a directory with
 * mode 0700: the store holds private keys and refresh tokens in plain JSON
 * because the upstream MCP server reads them that way, so the directory mode
 * is the only thing standing between them and another account on the machine.
 */

import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Turn a user-typed path into an absolute one.
 *
 * A leading `~` means the user's home directory. The panel pre-fills
 * `~/Downloads/<file>` and a shell never expands that for the plugin, so the
 * expansion has to happen here or the download lands in a literal `~`
 * directory next to the working directory.
 *
 * @param {string} target - the path the user typed.
 * @returns {string} the absolute path.
 */
export function resolveUserPath(target) {
	const raw = String(target ?? '').trim();
	if (raw === '~') return os.homedir();
	if (raw.startsWith('~/') || raw.startsWith('~\\')) {
		return path.join(os.homedir(), raw.slice(2));
	}
	return path.resolve(raw);
}

/**
 * Create a directory (and its parents) with restrictive permissions.
 *
 * @param {string} dir - absolute directory path.
 * @param {number} [mode] - permission bits; defaults to 0700.
 * @returns {Promise<void>} resolves once the directory exists.
 */
export async function ensureDir(dir, mode = 0o700) {
	await mkdir(dir, { recursive: true, mode });
	try {
		await chmod(dir, mode);
	} catch {
		// A directory we cannot chmod (someone else's mount) still works; the
		// file modes below are what actually protect the secrets.
	}
}

/**
 * Write one JSON file, replacing it atomically enough for our purposes and
 * forcing the requested mode even when the file already existed.
 *
 * @param {string} file - absolute file path.
 * @param {unknown} value - the JSON value to store.
 * @param {number} [mode] - permission bits; defaults to 0600.
 * @returns {Promise<void>} resolves once the file is written.
 */
export async function writeJsonFile(file, value, mode = 0o600) {
	await ensureDir(path.dirname(file), 0o700);
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
	try {
		await chmod(file, mode);
	} catch {
		// Best effort: an un-chmodable file is still readable only by its owner
		// on the platforms this plugin supports.
	}
}

/**
 * Read one JSON file.
 *
 * @param {string} file - absolute file path.
 * @returns {Promise<unknown|null>} the parsed value, or null when the file is absent.
 */
export async function readJsonFile(file) {
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if (error && error.code === 'ENOENT') return null;
		throw error;
	}
	if (text.trim() === '') return null;
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Remove one file, ignoring a missing one.
 *
 * @param {string} file - absolute file path.
 * @returns {Promise<boolean>} true when a file was removed.
 */
export async function removeFile(file) {
	try {
		await rm(file, { force: false });
		return true;
	} catch (error) {
		if (error && error.code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * List the `.json` files in one directory.
 *
 * @param {string} dir - absolute directory path.
 * @returns {Promise<string[]>} the file names, empty when the directory is absent.
 */
export async function listJsonFiles(dir) {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
	} catch (error) {
		if (error && error.code === 'ENOENT') return [];
		throw error;
	}
}

/**
 * Check whether a path exists.
 *
 * @param {string} file - absolute path.
 * @returns {Promise<boolean>} true when the path exists.
 */
export async function pathExists(file) {
	try {
		await readFile(file);
		return true;
	} catch (error) {
		if (error && error.code === 'ENOENT') return false;
		// A directory or a permission problem still means "something is there".
		return true;
	}
}
