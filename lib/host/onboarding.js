/**
 * The onboarding probe: what this machine can already supply.
 *
 * The panel can offer a one-click setup path when it knows what is already
 * installed: a `gcloud` binary with an active account, the OAuth client
 * files the user downloaded, and the service accounts a project owns.
 *
 * Two rules shape the code. The probe never fails: every field degrades on
 * its own, so a missing `gcloud` or an unreadable directory yields a partial
 * answer instead of an error. And nothing the browser sends reaches a
 * shell: `gcloud` runs from an argument array, and the project id and the
 * service-account email are checked against strict patterns before they are
 * used, so a crafted value cannot become another argument.
 */

import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DriveError, ERROR_CODES, invalidInput } from './errors.js';

/** How long one `gcloud` call may take. */
const GCLOUD_CALL_TIMEOUT_MS = 25000;

/** How long the whole detection may take. */
const DETECT_BUDGET_MS = 60000;

/** The largest amount of output one `gcloud` call may produce. */
const GCLOUD_MAX_BUFFER = 8 * 1024 * 1024;

/** How many candidate files one directory may contribute. */
const OAUTH_SCAN_LIMIT = 20;

/** How many OAuth clients the detection may report. */
const OAUTH_RESULT_LIMIT = 20;

/** How many service accounts the detection may report. */
const SERVICE_ACCOUNT_LIMIT = 50;

/** The file names an OAuth client may hide behind. */
const OAUTH_FILE_NAMES = ['credentials.json'];

/**
 * A Google Cloud project id: lowercase letters, digits and hyphens, starting
 * with a letter. Nothing else can reach `gcloud` as a project.
 */
export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,62}$/;

/**
 * A service-account address: the account name, the project, and the
 * `iam.gserviceaccount.com` suffix Google gives every service account.
 */
export const SERVICE_ACCOUNT_PATTERN = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

/**
 * Whether a file name may hold an OAuth client.
 *
 * @param {string} name - the file name.
 * @returns {boolean} true when the name is one of the known client names.
 */
function isOAuthClientFileName(name) {
	if (typeof name !== 'string') return false;
	if (OAUTH_FILE_NAMES.includes(name)) return true;
	return name.startsWith('client_secret_') && name.endsWith('.json');
}

/**
 * Read a string field, treating anything else as absent.
 *
 * @param {unknown} value - the candidate value.
 * @returns {string|null} the trimmed string, or null.
 */
function pickString(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * Parse the JSON array a `gcloud --format=json` call printed.
 *
 * The output can carry warnings before the payload, so the array starts at
 * the first `[`; an output without one is not an answer.
 *
 * @param {string} stdout - the command's standard output.
 * @returns {unknown[]|null} the parsed array, or null when there is none.
 */
function parseJsonArray(stdout) {
	if (typeof stdout !== 'string') return null;
	const start = stdout.indexOf('[');
	if (start < 0) return null;
	try {
		const parsed = JSON.parse(stdout.slice(start));
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Parse the JSON object a `gcloud` call printed.
 *
 * @param {string} stdout - the command's standard output.
 * @returns {object|null} the parsed object, or null when there is none.
 */
function parseJsonObject(stdout) {
	if (typeof stdout !== 'string') return null;
	const start = stdout.indexOf('{');
	if (start < 0) return null;
	try {
		const parsed = JSON.parse(stdout.slice(start));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The last lines of a command's error output.
 *
 * @param {string} stderr - the command's standard error.
 * @param {number} [lines] - how many lines to keep.
 * @returns {string} the tail, empty when there is none.
 */
function stderrTail(stderr, lines = 6) {
	if (typeof stderr !== 'string' || stderr.trim() === '') return '';
	return stderr
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line !== '')
		.slice(-lines)
		.join('\n');
}

/**
 * The onboarding probe the panel asks before the user types anything.
 */
export class OnboardingProbe {
	/**
	 * @param {object} options - the probe dependencies.
	 * @param {string} options.storeDir - the plugin's store directory.
	 * @param {string} [options.builtinClientId] - the OAuth client id the plugin ships, when it ships one.
	 * @param {string[]} [options.gcloudPaths] - the binary candidates to try instead of the default search.
	 * @param {object} [options.env] - the environment the search and the calls see.
	 * @param {string} [options.homeDir] - the home directory to scan.
	 * @param {number} [options.timeoutMs] - how long one call may take.
	 * @param {number} [options.budgetMs] - how long the whole detection may take.
	 */
	constructor({
		storeDir,
		builtinClientId = '',
		gcloudPaths = null,
		env = process.env,
		homeDir = os.homedir(),
		timeoutMs = GCLOUD_CALL_TIMEOUT_MS,
		budgetMs = DETECT_BUDGET_MS,
	} = {}) {
		this.storeDir = typeof storeDir === 'string' ? storeDir : '';
		// The client the plugin ships itself. Only the id is kept: the
		// secret never travels to the browser, and the probe only has to say
		// whether such a client exists at all.
		this.builtinClientId = typeof builtinClientId === 'string' ? builtinClientId.trim() : '';
		// An explicit list replaces the search entirely, so a caller can ask
		// for one exact binary — or for none at all.
		this.gcloudPaths = Array.isArray(gcloudPaths) ? gcloudPaths.filter((entry) => typeof entry === 'string' && entry !== '') : null;
		this.env = env && typeof env === 'object' ? env : {};
		this.homeDir = typeof homeDir === 'string' && homeDir !== '' ? homeDir : os.homedir();
		this.timeoutMs = timeoutMs;
		this.budgetMs = budgetMs;
		this.binaryPath = null;
		this.deadline = 0;
	}

	/**
	 * Report what this machine can already supply.
	 *
	 * The endpoint never fails because a probe failed: every field degrades on
	 * its own, so the panel always gets an answer it can render.
	 *
	 * @returns {Promise<{gcloud: object, oauthClients: object[], serviceAccounts: object[], builtinClient: {available: boolean}}>} the contract's payload.
	 */
	async detect() {
		this.deadline = Date.now() + this.budgetMs;
		try {
			const gcloud = await this.detectGcloud();
			const oauthClients = await this.findOauthClients();
			const serviceAccounts = await this.listServiceAccounts(gcloud.projects);
			return { gcloud, oauthClients, serviceAccounts, builtinClient: this.builtinClient() };
		} catch (error) {
			// A probe that throws is reported as "not available", never as an
			// error: the panel can still show what it found.
			return {
				gcloud: this.emptyGcloud(),
				oauthClients: [],
				serviceAccounts: [],
				builtinClient: this.builtinClient(),
			};
		}
	}

	/**
	 * Whether the plugin can offer a sign-in of its own.
	 *
	 * The panel asks this before it asks the user for a client id: a plugin
	 * that ships one can offer a one-click sign-in, and one that does not has
	 * to ask for the client the user made in the Cloud console. Only the
	 * answer travels — the id itself is public, but there is no reason to
	 * send it, and the secret never leaves the host.
	 *
	 * @returns {{available: boolean}} what the panel needs to know.
	 */
	builtinClient() {
		return { available: this.builtinClientId !== '' };
	}

	/**
	 * Mint a new key for an existing service account.
	 *
	 * The account must already exist; this only mints a key for it. The
	 * project id and the email are validated before anything runs, so a
	 * crafted value can never become a second argument.
	 *
	 * @param {object} payload - the request payload.
	 * @param {string} payload.projectId - the project the account belongs to.
	 * @param {string} payload.serviceAccountEmail - the account to mint a key for.
	 * @returns {Promise<{key: object}>} the contract's payload.
	 */
	async createServiceKey(payload) {
		const projectId = typeof payload?.projectId === 'string' ? payload.projectId.trim() : '';
		const serviceAccountEmail =
			typeof payload?.serviceAccountEmail === 'string' ? payload.serviceAccountEmail.trim() : '';
		if (!PROJECT_ID_PATTERN.test(projectId)) {
			throw invalidInput('That is not a valid Google Cloud project id.', { field: 'projectId' });
		}
		if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccountEmail)) {
			throw invalidInput('That is not a valid service-account email address.', {
				field: 'serviceAccountEmail',
			});
		}
		const binary = await this.findBinary();
		if (!binary) {
			throw new DriveError(
				ERROR_CODES.INTERNAL,
				'The Google Cloud CLI (gcloud) is not installed on this machine, so no key can be created.',
				{ field: 'gcloud' },
			);
		}
		this.deadline = Date.now() + this.budgetMs;
		const result = this.run(
			[
				'iam',
				'service-accounts',
				'keys',
				'create',
				`--iam-account=${serviceAccountEmail}`,
				`--project=${projectId}`,
				'--key-file-type=json',
				'--quiet',
				'--format=json',
			],
			this.remainingTimeout(),
		);
		if (!result.ok) {
			const tail = stderrTail(result.stderr);
			throw new DriveError(
				ERROR_CODES.INTERNAL,
				`gcloud could not create a key for ${serviceAccountEmail}: ${tail || 'it reported no error output.'}`,
				{ projectId, serviceAccountEmail, stderr: tail },
			);
		}
		const key = parseJsonObject(result.stdout);
		if (!key) {
			throw new DriveError(
				ERROR_CODES.INTERNAL,
				'gcloud did not return a service-account key.',
				{ projectId, serviceAccountEmail },
			);
		}
		// The key carries its own id, so the plugin knows which key it just
		// minted — and, with it, which of the account's other keys are the
		// old ones. gcloud names a key by that id.
		const keyId = pickString(key.private_key_id);
		const otherKeys = await this.listOtherKeys({ projectId, serviceAccountEmail, keepKeyId: keyId });
		return { key, keyId, otherKeys };
	}

	/**
	 * The other keys one service account already has.
	 *
	 * `gcloud` names a key by its id, so the ids in this list are exactly
	 * what `gcloud iam service-accounts keys delete` takes. The plugin
	 * reports them instead of revoking them on its own: a key can be
	 * shared with an account outside this plugin, and revoking it would
	 * break that one too.
	 *
	 * @param {object} options - the request options.
	 * @param {string} options.projectId - the project the account belongs to.
	 * @param {string} options.serviceAccountEmail - the account to look at.
	 * @param {string|null} [options.keepKeyId] - the key id to leave out.
	 * @returns {Promise<object[]>} the other keys, each `{ id, createdAt }`.
	 */
	async listOtherKeys({ projectId, serviceAccountEmail, keepKeyId = null }) {
		if (!PROJECT_ID_PATTERN.test(String(projectId ?? ''))) {
			throw invalidInput('That is not a valid Google Cloud project id.', { field: 'projectId' });
		}
		if (!SERVICE_ACCOUNT_PATTERN.test(String(serviceAccountEmail ?? ''))) {
			throw invalidInput('That is not a valid service-account email address.', {
				field: 'serviceAccountEmail',
			});
		}
		const binary = await this.findBinary();
		if (!binary) return [];
		this.deadline = Date.now() + this.budgetMs;
		const result = this.run(
			[
				'iam',
				'service-accounts',
				'keys',
				'list',
				`--iam-account=${serviceAccountEmail}`,
				`--project=${projectId}`,
				'--format=json',
			],
			this.remainingTimeout(),
		);
		if (!result.ok) return [];
		const parsed = parseJsonArray(result.stdout);
		if (!parsed) return [];
		const keys = [];
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue;
			const id = pickString(entry.name);
			if (!id || id === keepKeyId) continue;
			keys.push({ id, createdAt: pickString(entry.validAfterTime ?? entry.createTime) });
		}
		return keys;
	}

	/** Release what this probe holds. */
	dispose() {
		this.binaryPath = null;
	}

	/**
	 * The `gcloud` state the contract describes.
	 *
	 * @returns {object} the empty state.
	 */
	emptyGcloud() {
		return {
			available: false,
			path: this.binaryPath,
			version: null,
			authenticated: false,
			account: null,
			projects: [],
		};
	}

	/**
	 * Probe `gcloud` and the account it holds.
	 *
	 * @returns {Promise<object>} the contract's `gcloud` object.
	 */
	async detectGcloud() {
		const binary = await this.findBinary();
		if (!binary) return this.emptyGcloud();
		const version = this.readVersion();
		if (!version.ok) {
			return { ...this.emptyGcloud(), path: binary };
		}
		const account = this.readActiveAccount();
		const projects = this.readProjects();
		return {
			available: true,
			path: binary,
			version: version.value,
			authenticated: account !== null,
			account,
			projects,
		};
	}

	/**
	 * The version `gcloud` reports.
	 *
	 * @returns {{ok: boolean, value: string|null}} the version.
	 */
	readVersion() {
		const result = this.run(['version'], this.remainingTimeout());
		if (!result.ok) return { ok: false, value: null };
		const match = result.stdout.match(/Google Cloud SDK\s+(\S+)/);
		if (match) return { ok: true, value: match[1] };
		const first = result.stdout
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line !== '');
		return { ok: true, value: first ?? null };
	}

	/**
	 * The account `gcloud` is signed in as.
	 *
	 * @returns {string|null} the active account, or null when there is none.
	 */
	readActiveAccount() {
		const result = this.run(
			['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
			this.remainingTimeout(),
		);
		if (!result.ok) return null;
		const first = result.stdout
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line !== '');
		return first ?? null;
	}

	/**
	 * The projects `gcloud` can reach.
	 *
	 * @returns {object[]} the projects, each `{ id, name }`.
	 */
	readProjects() {
		const result = this.run(['projects', 'list', '--format=json'], this.remainingTimeout());
		if (!result.ok) return [];
		const parsed = parseJsonArray(result.stdout);
		if (!parsed) return [];
		const projects = [];
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue;
			const id = pickString(entry.projectId ?? entry.id);
			if (!id) continue;
			projects.push({ id, name: pickString(entry.name) ?? id });
		}
		return projects;
	}

	/**
	 * The service accounts the reachable projects own.
	 *
	 * The calls run one after another: `gcloud` locks its own configuration
	 * directory, so parallel calls would fight each other. The budget cuts
	 * the list short rather than letting the panel wait forever.
	 *
	 * @param {object[]} projects - the projects to look in.
	 * @returns {Promise<object[]>} the service accounts.
	 */
	async listServiceAccounts(projects) {
		const accounts = [];
		const seen = new Set();
		for (const project of projects) {
			if (accounts.length >= SERVICE_ACCOUNT_LIMIT) break;
			if (this.remaining() <= 0) break;
			const id = pickString(project?.id);
			if (!id || !PROJECT_ID_PATTERN.test(id)) continue;
			const result = this.run(
				['iam', 'service-accounts', 'list', `--project=${id}`, '--format=json'],
				this.remainingTimeout(),
			);
			if (!result.ok) continue;
			const parsed = parseJsonArray(result.stdout);
			if (!parsed) continue;
			for (const entry of parsed) {
				if (!entry || typeof entry !== 'object') continue;
				const email = pickString(entry.email);
				if (!email || seen.has(email)) continue;
				seen.add(email);
				accounts.push({
					email,
					projectId: id,
					displayName: pickString(entry.displayName),
				});
				if (accounts.length >= SERVICE_ACCOUNT_LIMIT) break;
			}
		}
		return accounts;
	}

	/**
	 * Find the OAuth client files on this machine.
	 *
	 * The search stays shallow on purpose: a handful of well-known
	 * directories, one level deep, a capped number of files. The client
	 * secret never leaves the disk — the chooser only needs the id.
	 *
	 * @returns {Promise<object[]>} the clients, each `{ path, clientId, projectName, type }`.
	 */
	async findOauthClients() {
		const directories = [
			path.join(this.homeDir, 'Downloads'),
			path.join(this.homeDir, 'Desktop'),
			path.join(this.homeDir, '.config', 'gcloud'),
			path.join(this.homeDir, '.credentials'),
			this.storeDir,
		];
		const clients = [];
		const seen = new Set();
		for (const directory of directories) {
			if (clients.length >= OAUTH_RESULT_LIMIT) break;
			if (typeof directory !== 'string' || directory === '') continue;
			for (const file of await this.scanDirectory(directory)) {
				const client = this.parseClientFile(file);
				if (!client || seen.has(client.path)) continue;
				seen.add(client.path);
				clients.push(client);
				if (clients.length >= OAUTH_RESULT_LIMIT) break;
			}
		}
		return clients;
	}

	/**
	 * Look for client files in one directory and its immediate children.
	 *
	 * @param {string} directory - the directory to scan.
	 * @returns {Promise<{path: string, data: unknown}[]>} the candidate files.
	 */
	async scanDirectory(directory) {
		const found = [];
		let scanned = 0;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			// An unreadable directory yields nothing at all.
			return found;
		}
		const visit = async (target, name) => {
			if (scanned >= OAUTH_SCAN_LIMIT) return;
			if (!isOAuthClientFileName(name)) return;
			scanned += 1;
			try {
				const text = await readFile(target, 'utf8');
				found.push({ path: target, data: JSON.parse(text) });
			} catch {
				// A file that cannot be read or parsed is simply not a client.
			}
		};
		for (const entry of entries) {
			if (scanned >= OAUTH_SCAN_LIMIT) break;
			const target = path.join(directory, entry.name);
			if (entry.isFile()) {
				await visit(target, entry.name);
				continue;
			}
			if (!entry.isDirectory()) continue;
			let children;
			try {
				children = await readdir(target, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const child of children) {
				if (!child.isFile()) continue;
				await visit(path.join(target, child.name), child.name);
				if (scanned >= OAUTH_SCAN_LIMIT) break;
			}
		}
		return found;
	}

	/**
	 * Turn one parsed client file into the record the chooser needs.
	 *
	 * @param {{path: string, data: unknown}} file - the parsed file.
	 * @returns {{path: string, clientId: string, projectName: string|null, type: string}|null} the client, or null.
	 */
	parseClientFile(file) {
		const data = file?.data;
		if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
		const web = data.web && typeof data.web === 'object' ? data.web : null;
		const installed = data.installed && typeof data.installed === 'object' ? data.installed : null;
		const section = web ?? installed;
		if (!section) return null;
		const clientId = pickString(data.client_id) ?? pickString(section.client_id);
		if (!clientId || !clientId.endsWith('.apps.googleusercontent.com')) return null;
		const projectName =
			pickString(data.project_id) ??
			pickString(section.project_id) ??
			pickString(section.project_name) ??
			null;
		return { path: file.path, clientId, projectName, type: web ? 'web' : 'installed' };
	}

	/**
	 * Find the `gcloud` binary this machine has.
	 *
	 * @returns {Promise<string|null>} the absolute path, or null when there is none.
	 */
	async findBinary() {
		if (this.binaryPath) return this.binaryPath;
		for (const candidate of await this.gcloudCandidates()) {
			const resolved = await this.resolveCandidate(candidate);
			if (resolved) {
				this.binaryPath = resolved;
				return resolved;
			}
		}
		return null;
	}

	/**
	 * The binary candidates to try, in order.
	 *
	 * @returns {Promise<string[]>} the candidates.
	 */
	async gcloudCandidates() {
		if (this.gcloudPaths) return [...this.gcloudPaths];
		const candidates = [];
		const fromEnv = pickString(this.env.GCLOUD);
		if (fromEnv) candidates.push(fromEnv);
		const onPath = await this.findOnPath('gcloud');
		if (onPath) candidates.push(onPath);
		candidates.push(path.join(this.homeDir, 'google-cloud-sdk', 'bin', 'gcloud'));
		candidates.push('/opt/homebrew/bin/gcloud');
		return candidates;
	}

	/**
	 * Turn one candidate into an absolute path to a runnable binary.
	 *
	 * @param {string} candidate - the candidate.
	 * @returns {Promise<string|null>} the absolute path, or null.
	 */
	async resolveCandidate(candidate) {
		if (typeof candidate !== 'string' || candidate === '') return null;
		if (candidate.includes('/') || candidate.includes(path.sep)) {
			return (await this.isRunnable(candidate)) ? path.resolve(candidate) : null;
		}
		return await this.findOnPath(candidate);
	}

	/**
	 * Find an executable by name on the `PATH`.
	 *
	 * @param {string} name - the executable name.
	 * @returns {Promise<string|null>} the absolute path, or null.
	 */
	async findOnPath(name) {
		const searchPath = typeof this.env.PATH === 'string' ? this.env.PATH : '';
		if (searchPath === '') return null;
		for (const directory of searchPath.split(path.delimiter)) {
			if (directory === '') continue;
			for (const fileName of [name, `${name}.exe`]) {
				const candidate = path.join(directory, fileName);
				if (await this.isRunnable(candidate)) return candidate;
			}
		}
		return null;
	}

	/**
	 * Whether a path names a file this user may run.
	 *
	 * @param {string} candidate - the path.
	 * @returns {Promise<boolean>} true when the file is executable.
	 */
	async isRunnable(candidate) {
		try {
			await access(candidate, constants.X_OK);
			return (await stat(candidate)).isFile();
		} catch {
			return false;
		}
	}

	/**
	 * Run one `gcloud` call.
	 *
	 * The command runs from an argument array, so no value can be read as
	 * shell syntax, and it is given a timeout and a bounded buffer: `gcloud`
	 * can hang and can print megabytes of warnings.
	 *
	 * @param {string[]} args - the arguments.
	 * @param {number} timeoutMs - how long the call may take.
	 * @returns {{ok: boolean, stdout: string, stderr: string, status: number|null}} the outcome.
	 */
	run(args, timeoutMs) {
		if (!this.binaryPath) return { ok: false, stdout: '', stderr: '', status: null };
		try {
			const result = spawnSync(this.binaryPath, args, {
				timeout: timeoutMs,
				encoding: 'utf8',
				maxBuffer: GCLOUD_MAX_BUFFER,
				windowsHide: true,
				shell: false,
				env: this.env,
			});
			if (result.error) {
				return { ok: false, stdout: '', stderr: result.error.message, status: null };
			}
			const stdout = typeof result.stdout === 'string' ? result.stdout : '';
			const stderr = typeof result.stderr === 'string' ? result.stderr : '';
			return { ok: result.status === 0, stdout, stderr, status: result.status ?? null };
		} catch (error) {
			return {
				ok: false,
				stdout: '',
				stderr: error instanceof Error ? error.message : String(error),
				status: null,
			};
		}
	}

	/**
	 * How much of the detection budget is left.
	 *
	 * @returns {number} the remaining milliseconds.
	 */
	remaining() {
		return Math.max(0, this.deadline - Date.now());
	}

	/**
	 * The timeout the next call may use.
	 *
	 * @returns {number} the timeout in milliseconds.
	 */
	remainingTimeout() {
		const left = this.remaining();
		if (left <= 0) return 1;
		return Math.max(1000, Math.min(this.timeoutMs, left));
	}
}
