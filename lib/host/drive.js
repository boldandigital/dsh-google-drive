/**
 * The Drive REST API.
 *
 * Only the four calls the contract needs are implemented, on top of the
 * documented v3 endpoints: list, search, metadata, download/export and
 * upload. Google-native documents (the `application/vnd.google-apps.*`
 * family) have no bytes of their own and must be exported; every other file
 * is downloaded with `alt=media`.
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { DriveError, ERROR_CODES, invalidInput } from './errors.js';
import { escapeDriveQueryValue, REQUEST_TIMEOUT_MS } from './google-api.js';

/** The Drive files endpoint. */
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/**
 * The host that accepts an upload.
 *
 * A multipart body has to go to the media host: the plain API host parses
 * every body as JSON and answers a multipart upload with
 * "Invalid JSON payload received".
 */
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/** The metadata fields the contract's DriveFile carries. */
export const DRIVE_FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink';

/**
 * The largest file this plugin holds in memory at once.
 *
 * The download is one buffer, so a very large file would take the whole
 * harness down with it. A hundred megabytes is plenty for a document and
 * small enough to be safe.
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** The mime type Drive gives a folder. */
export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * The export formats Google can produce for each kind of native document.
 *
 * Google refuses a conversion it does not support ("The requested
 * conversion is not supported"), so the list a caller may choose from is
 * narrowed by the kind of file it is exporting.
 */
export const EXPORT_FORMATS_BY_MIME = {
	'application/vnd.google-apps.document': ['pdf', 'docx', 'txt', 'html'],
	'application/vnd.google-apps.spreadsheet': ['pdf', 'xlsx', 'csv'],
	'application/vnd.google-apps.presentation': ['pdf', 'pptx', 'txt'],
	'application/vnd.google-apps.drawing': ['pdf', 'png', 'jpeg'],
	'application/vnd.google-apps.script': ['application/vnd.google-apps.script+json', 'txt'],
	'application/vnd.google-apps.form': ['pdf'],
};

/** How a native Google document is exported for each supported format. */
export const EXPORT_MIME_TYPES = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	txt: 'text/plain',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	csv: 'text/csv',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	html: 'text/html',
	png: 'image/png',
	jpeg: 'image/jpeg',
};

/** The export formats the contract accepts. */
export const EXPORT_FORMATS = Object.keys(EXPORT_MIME_TYPES);

/** Content types guessed from a file name when the caller names none. */
const MIME_BY_EXTENSION = {
	'.csv': 'text/csv',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.html': 'text/html',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.json': 'application/json',
	'.md': 'text/markdown',
	'.pdf': 'application/pdf',
	'.png': 'image/png',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'.txt': 'text/plain',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.zip': 'application/zip',
};

/**
 * Whether a mime type belongs to a native Google document.
 *
 * @param {unknown} mimeType - the mime type of a file.
 * @returns {boolean} true when the file must be exported rather than downloaded.
 */
export function isGoogleNativeMime(mimeType) {
	if (typeof mimeType !== 'string') return false;
	if (!mimeType.startsWith('application/vnd.google-apps.')) return false;
	// A folder is a Google-native type too, but it holds files instead of
	// being one: there is nothing to export.
	return mimeType !== GOOGLE_FOLDER_MIME;
}

/**
 * Guess a content type from a file name.
 *
 * @param {string} filePath - the path of the file.
 * @returns {string} the content type.
 */
export function guessMimeType(filePath) {
	const extension = path.extname(String(filePath)).toLowerCase();
	return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * Turn one Drive file object into the shape the contract describes.
 *
 * @param {object} file - the raw Drive file.
 * @returns {object} the normalized file.
 */
export function normalizeDriveFile(file) {
	const raw = file && typeof file === 'object' ? file : {};
	return {
		id: typeof raw.id === 'string' ? raw.id : '',
		name: typeof raw.name === 'string' ? raw.name : '',
		mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : '',
		size: Number.isFinite(raw.size) ? raw.size : 0,
		modifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : '',
		parents: Array.isArray(raw.parents) ? raw.parents.filter((parent) => typeof parent === 'string') : [],
		webViewLink: typeof raw.webViewLink === 'string' ? raw.webViewLink : '',
		iconLink: typeof raw.iconLink === 'string' ? raw.iconLink : '',
	};
}

/**
 * The Drive API as the contract needs it.
 */
export class DriveClient {
	/**
	 * @param {object} options - the client dependencies.
	 * @param {() => Promise<string>} options.getAccessToken - returns a fresh access token.
	 * @param {typeof fetch} [options.fetchImpl] - the fetch implementation.
	 */
	constructor({ getAccessToken, fetchImpl }) {
		this.getAccessToken = getAccessToken;
		this.fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
	}

	/**
	 * Perform one authorized request.
	 *
	 * @param {string} url - the target URL.
	 * @param {object} [init] - the fetch init.
	 * @param {AbortSignal} [signal] - the caller's cancellation signal.
	 * @returns {Promise<Response>} the successful response.
	 */
	async request(url, init = {}, signal) {
		const token = await this.getAccessToken();
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response;
		try {
			response = await this.fetch(url, {
				...init,
				signal: combined,
				headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
			});
		} catch (error) {
			if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) throw error;
			throw new DriveError(
				ERROR_CODES.DRIVE_API,
				`Could not reach Google Drive (${error instanceof Error ? error.message : String(error)}).`,
				{ url },
			);
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new DriveError(
				ERROR_CODES.DRIVE_API,
				`Google Drive answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}.`,
				{ status: response.status },
			);
		}
		return response;
	}

	/**
	 * Build the query for a folder listing.
	 *
	 * @param {string} folderId - the folder to list.
	 * @param {string|null} query - an optional Drive query fragment.
	 * @returns {string} the `q` parameter.
	 */
	static folderQuery(folderId, query) {
		const parent = `'${escapeDriveQueryValue(folderId)}' in parents`;
		// The trash filter stays in place even when the caller adds a query of
		// its own; a caller that wants trashed files asks for them explicitly.
		if (typeof query === 'string' && query.trim() !== '') {
			return `${parent} and trashed = false and (${query.trim()})`;
		}
		return `${parent} and trashed = false`;
	}

	/**
	 * Build the query that lists the account's top-level items.
	 *
	 * A service account sees the files shared with it at the top of its
	 * Drive, and Drive reports those items with NO `parents` at all: they are
	 * not in a folder, so the usual `'root' in parents` filter matches
	 * nothing and the account looks empty. The upstream `google-workspace-mcp`
	 * server has the same blind spot — its `listFolderContents` reports an
	 * empty folder for a service account whose files are plainly visible.
	 *
	 * The Drive query language cannot express "has no parent" directly, so
	 * the negation is used instead: `not 'root' in parents` keeps the shared
	 * top-level items, and the parent filter is applied afterwards for a
	 * normal account.
	 *
	 * @param {string|null} query - an optional Drive query fragment.
	 * @returns {string} the `q` parameter.
	 */
	static rootQuery(query) {
		const filter = typeof query === 'string' && query.trim() !== '' ? `(${query.trim()}) and ` : '';
		return `${filter}not 'root' in parents and trashed = false`;
	}

	/**
	 * Build the query for a name search.
	 *
	 * @param {string} name - the name fragment to look for.
	 * @returns {string} the `q` parameter.
	 */
	static nameQuery(name) {
		return `name contains '${escapeDriveQueryValue(name)}' and trashed = false`;
	}

	/**
	 * List the files in one folder.
	 *
	 * @param {object} options - the request options.
	 * @param {string} [options.folderId] - the folder; defaults to the root.
	 * @param {number} [options.pageSize] - how many files to return.
	 * @param {string} [options.query] - an optional Drive query fragment.
	 * @param {string} [options.pageToken] - the continuation token.
	 * @param {AbortSignal} [options.signal] - the caller's cancellation signal.
	 * @returns {Promise<{files: object[], nextPageToken: string|undefined}>} the page.
	 */
	async listFiles({ folderId = 'root', pageSize = 50, query, pageToken, signal, sharedRoot = false, rootAlias = null } = {}) {
		// A service account's shared items carry no `parents`, so the root
		// listing uses the negated query and then keeps only the items that
		// really are top level. A normal account lists its folder directly.
		const isRoot = folderId === 'root';
		const useSharedRoot = sharedRoot && isRoot;
		const params = new URLSearchParams({
			q: useSharedRoot ? DriveClient.rootQuery(query) : DriveClient.folderQuery(folderId, query),
			pageSize: String(Math.max(1, Math.min(1000, Number(pageSize) || 50))),
			fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
			supportsAllDrives: 'true',
			includeItemsFromAllDrives: 'true',
		});
		if (pageToken) params.set('pageToken', pageToken);
		const response = await this.request(`${DRIVE_FILES_URL}?${params}`, { method: 'GET' }, signal);
		const payload = await response.json();
		const raw = Array.isArray(payload?.files) ? payload.files : [];
		// `not 'root' in parents` also matches items nested deeper in a shared
		// folder, so the top level is picked out here. An item is at the top
		// when it has no parent at all — that is how Drive reports an item
		// shared with a service account — or when its parent is the
		// account's own root folder.
		const files = useSharedRoot
			? raw.filter((file) => {
					const parents = Array.isArray(file?.parents) ? file.parents : [];
					if (parents.length === 0) return true;
					return typeof rootAlias === 'string' && rootAlias !== '' && parents.includes(rootAlias);
				})
			: raw;
		return {
			files: files.map(normalizeDriveFile),
			nextPageToken: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : undefined,
		};
	}

	/**
	 * Search for files by name.
	 *
	 * @param {object} options - the request options.
	 * @param {string} options.query - the name fragment to look for.
	 * @param {number} [options.pageSize] - how many files to return.
	 * @param {string} [options.pageToken] - the continuation token.
	 * @param {AbortSignal} [options.signal] - the caller's cancellation signal.
	 * @returns {Promise<{files: object[], nextPageToken: string|undefined}>} the page.
	 */
	async searchFiles({ query, pageSize = 50, pageToken, signal } = {}) {
		if (typeof query !== 'string' || query.trim() === '') {
			throw invalidInput('A search needs a name to look for.', { field: 'query' });
		}
		const params = new URLSearchParams({
			q: DriveClient.nameQuery(query.trim()),
			pageSize: String(Math.max(1, Math.min(1000, Number(pageSize) || 50))),
			fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
			supportsAllDrives: 'true',
			includeItemsFromAllDrives: 'true',
		});
		if (pageToken) params.set('pageToken', pageToken);
		const response = await this.request(`${DRIVE_FILES_URL}?${params}`, { method: 'GET' }, signal);
		const payload = await response.json();
		return {
			files: Array.isArray(payload?.files) ? payload.files.map(normalizeDriveFile) : [],
			nextPageToken: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : undefined,
		};
	}

	/**
	 * Read the metadata of one file.
	 *
	 * @param {string} fileId - the file to read.
	 * @param {AbortSignal} [signal] - the caller's cancellation signal.
	 * @returns {Promise<object>} the normalized file.
	 */
	async getFile(fileId, signal) {
		const params = new URLSearchParams({ fields: DRIVE_FILE_FIELDS, supportsAllDrives: 'true' });
		const response = await this.request(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?${params}`, { method: 'GET' }, signal);
		return normalizeDriveFile(await response.json());
	}

	/**
	 * Read the id of the account's own root folder.
	 *
	 * Drive answers `files.get('root')` with the account's "My Drive" id.
	 *
	 * @param {AbortSignal} [signal] - the caller's cancellation signal.
	 * @returns {Promise<string|null>} the root folder id, or null when unknown.
	 */
	async rootFolderId(signal) {
		const params = new URLSearchParams({ fields: 'id', supportsAllDrives: 'true' });
		const response = await this.request(`${DRIVE_FILES_URL}/root?${params}`, { method: 'GET' }, signal);
		const payload = await response.json();
		return typeof payload?.id === 'string' && payload.id !== '' ? payload.id : null;
	}

	/**
	 * Download one file, exporting it when it is a native Google document.
	 *
	 * @param {object} options - the request options.
	 * @param {string} options.fileId - the file to download.
	 * @param {string} [options.exportFormat] - the export format for native documents.
	 * @param {AbortSignal} [options.signal] - the caller's cancellation signal.
	 * @returns {Promise<{bytes: Buffer, mimeType: string}>} the content.
	 */
	async downloadFile({ fileId, exportFormat, signal }) {
		const metadata = await this.getFile(fileId, signal);
		if (metadata.mimeType === GOOGLE_FOLDER_MIME) {
			throw invalidInput(
				`"${metadata.name}" is a folder, not a file; list it with google_drive_list_files and take a file from it.`,
				{ field: 'fileId', fileId },
			);
		}
		const native = isGoogleNativeMime(metadata.mimeType);
		let url;
		if (native) {
			// Google refuses a conversion it does not support, so only the
			// formats that work for THIS kind of document are offered.
			const formats = EXPORT_FORMATS_BY_MIME[metadata.mimeType] || ['pdf', 'txt'];
			if (typeof exportFormat !== 'string' || exportFormat.trim() === '') {
				throw invalidInput(
					`"${metadata.name}" is a Google document and must be exported; name one of ${formats.join(', ')}.`,
					{ field: 'exportFormat', fileId },
				);
			}
			const format = exportFormat.trim().toLowerCase();
			const mime = EXPORT_MIME_TYPES[format];
			if (!mime || !formats.includes(format)) {
				throw invalidInput(
					`"${metadata.name}" cannot be exported as "${exportFormat}". Use one of ${formats.join(', ')}.`,
					{ field: 'exportFormat', fileId },
				);
			}
			url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mime)}`;
		} else {
			if (typeof exportFormat === 'string' && exportFormat.trim() !== '') {
				throw invalidInput(
					`"${metadata.name}" is an ordinary file and cannot be exported; drop exportFormat to download it as it is.`,
					{ field: 'exportFormat', fileId },
				);
			}
			url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
		}
		const response = await this.request(url, { method: 'GET' }, signal);
		// The whole file is held in memory, so a file that is too big is
		// refused rather than pulled in: the harness would go down with it.
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
			throw invalidInput(
				`"${metadata.name}" is ${declared} bytes, which is more than the ${MAX_DOWNLOAD_BYTES} bytes this plugin downloads at once.`,
				{ field: 'fileId', fileId },
			);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > MAX_DOWNLOAD_BYTES) {
			throw invalidInput(
				`"${metadata.name}" is larger than the ${MAX_DOWNLOAD_BYTES} bytes this plugin downloads at once.`,
				{ field: 'fileId', fileId },
			);
		}
		return { bytes, mimeType: response.headers.get('content-type') ?? metadata.mimeType };
	}

	/**
	 * Upload one local file.
	 *
	 * @param {object} options - the request options.
	 * @param {Buffer} options.bytes - the file content.
	 * @param {string} options.name - the name to store the file under.
	 * @param {string} [options.folderId] - the parent folder.
	 * @param {string} [options.mimeType] - the content type.
	 * @param {AbortSignal} [options.signal] - the caller's cancellation signal.
	 * @returns {Promise<object>} the stored file.
	 */
	async uploadFile({ bytes, name, folderId, mimeType, signal }) {
		const boundary = `dsh-google-drive-${randomBytes(16).toString('hex')}`;
		const metadata = { name };
		if (typeof folderId === 'string' && folderId.trim() !== '') metadata.parents = [folderId.trim()];
		if (typeof mimeType === 'string' && mimeType.trim() !== '') metadata.mimeType = mimeType.trim();
		const body = Buffer.concat([
			Buffer.from(
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
				'utf8',
			),
			Buffer.from(`--${boundary}\r\nContent-Type: ${metadata.mimeType ?? 'application/octet-stream'}\r\n\r\n`, 'utf8'),
			bytes,
			Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
		]);
		const params = new URLSearchParams({ uploadType: 'multipart', supportsAllDrives: 'true' });
		const response = await this.request(
			`${DRIVE_UPLOAD_URL}?${params}`,
			{ method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body },
			signal,
		);
		return normalizeDriveFile(await response.json());
	}
}
