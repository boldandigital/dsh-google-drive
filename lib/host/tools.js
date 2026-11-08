/**
 * The agent tools.
 *
 * Five tools expose reading and writing Drive files. Adding, replacing and
 * removing an account is deliberately absent: granting an account is a
 * decision the user makes, so no model-facing tool can make it.
 */

import path from 'node:path';

/** How long one Drive call may take. */
const TOOL_TIMEOUT_MS = 120000;

/**
 * A string that may be absent.
 *
 * The harness validates a tool's result against its declared output schema,
 * so a field that is `null` for one kind of account needs a schema that says
 * so — a plain `{ type: 'string' }` would reject every service account whose
 * email has not been probed yet.
 */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] };

/** The shape of one account in a tool result. */
const ACCOUNT_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		email: NULLABLE_STRING,
		type: { type: 'string' },
		subject: NULLABLE_STRING,
		addedAt: NULLABLE_STRING,
		scopes: { type: 'array', items: { type: 'string' } },
		status: { type: 'string' },
	},
	required: ['name', 'type', 'status'],
};

/** The shape of one Drive file in a tool result. */
const FILE_SCHEMA = {
	type: 'object',
	properties: {
		id: { type: 'string' },
		name: { type: 'string' },
		mimeType: { type: 'string' },
		size: { type: 'number' },
		modifiedTime: { type: 'string' },
		parents: { type: 'array', items: { type: 'string' } },
		webViewLink: { type: 'string' },
		iconLink: { type: 'string' },
	},
	required: ['id', 'name', 'mimeType'],
};

/** The shape of a file list in a tool result. */
const FILES_SCHEMA = {
	type: 'object',
	properties: {
		files: { type: 'array', items: FILE_SCHEMA },
		nextPageToken: NULLABLE_STRING,
	},
	required: ['files'],
};

/** The shape of the account list in a tool result. */
const ACCOUNTS_SCHEMA = {
	type: 'object',
	properties: {
		accounts: { type: 'array', items: ACCOUNT_SCHEMA },
		mcpBridge: {
			type: 'object',
			properties: {
				enabled: { type: 'boolean' },
				path: NULLABLE_STRING,
				installed: { type: 'boolean' },
			},
		},
		storage: { type: 'string' },
	},
	required: ['accounts'],
};

/**
 * Wrap one text in the content-block shape the harness renders.
 *
 * @param {string} text - the text the model should read.
 * @returns {object[]} one text block.
 */
function oneText(text) {
	return [{ type: 'text', text }];
}

/**
 * Render a list of files as text.
 *
 * @param {object[]} files - the files to render.
 * @returns {object[]} one text block.
 */
function renderFiles(files) {
	if (!Array.isArray(files) || files.length === 0) return oneText('No files matched.');
	const lines = files.map((file) => {
		const size = Number.isFinite(file.size) && file.size > 0 ? `, ${file.size} bytes` : '';
		const modified = file.modifiedTime ? `, changed ${file.modifiedTime}` : '';
		return `- ${file.name} (${file.mimeType}${size}${modified})\n  id: ${file.id}`;
	});
	return oneText(`${files.length} file(s):\n${lines.join('\n')}`);
}

/**
 * Resolve a local path against the session's working directory.
 *
 * @param {string} value - the path the model named.
 * @param {object} [exec] - the tool execution context.
 * @returns {string} the absolute path.
 */
function resolveLocalPath(value, exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd();
	return path.resolve(base, value);
}

/**
 * Build the tool definitions.
 *
 * @param {import('./service.js').GoogleDriveService} service - the account manager.
 * @returns {object[]} the tool definitions, ready for `ctx.tools.register`.
 */
export function buildDriveTools(service) {
	return [
		{
			name: 'google_drive_list_accounts',
			description:
				'List the Google Drive accounts this machine can use. Start here when a Drive call needs an account name.',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			output: {
				schema: ACCOUNTS_SCHEMA,
				render: (_args, value) => {
					const accounts = Array.isArray(value?.accounts) ? value.accounts : [];
					if (accounts.length === 0) return oneText('No Google Drive accounts are configured yet.');
					const lines = accounts.map(
						(account) =>
							`- ${account.name} (${account.type}${account.email ? `, ${account.email}` : ''}, ${account.status})`,
					);
					return oneText(`${accounts.length} account(s):\n${lines.join('\n')}`);
				},
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			async execute() {
				return await service.listAccounts();
			},
		},
		{
			name: 'google_drive_list_files',
			description: 'List the files in a Google Drive folder. Defaults to the account\'s root folder.',
			parameters: {
				type: 'object',
				properties: {
					account: { type: 'string', description: 'Name of the Google Drive account to use' },
					folderId: { type: 'string', description: 'Folder to list; defaults to "root"' },
					pageSize: { type: 'number', description: 'How many files to return (1-1000, default 50)' },
				},
				required: ['account'],
				additionalProperties: false,
			},
			output: {
				schema: FILES_SCHEMA,
				render: (_args, value) => renderFiles(value?.files),
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			async execute(args, exec) {
				return await service.listFiles(
					{
						account: args.account,
						folderId: args.folderId,
						pageSize: args.pageSize,
					},
					exec?.signal,
				);
			},
		},
		{
			name: 'google_drive_search_files',
			description: 'Search Google Drive for files whose name contains the given text.',
			parameters: {
				type: 'object',
				properties: {
					account: { type: 'string', description: 'Name of the Google Drive account to use' },
					query: { type: 'string', description: 'Text to look for in file names' },
					pageSize: { type: 'number', description: 'How many files to return (1-1000, default 50)' },
				},
				required: ['account', 'query'],
				additionalProperties: false,
			},
			output: {
				schema: FILES_SCHEMA,
				render: (_args, value) => renderFiles(value?.files),
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			async execute(args, exec) {
				return await service.searchFiles(
					{
						account: args.account,
						query: args.query,
						pageSize: args.pageSize,
					},
					exec?.signal,
				);
			},
		},
		{
			name: 'google_drive_download_file',
			description:
				'Download a Google Drive file to this machine. A Google document (Docs, Sheets, Slides) must name an export format such as pdf, docx, xlsx or txt.',
			parameters: {
				type: 'object',
				properties: {
					account: { type: 'string', description: 'Name of the Google Drive account to use' },
					fileId: { type: 'string', description: 'Id of the file to download' },
					path: { type: 'string', description: 'Where to write the file on this machine' },
					exportFormat: {
						type: 'string',
						description: 'Export format for Google documents: pdf, docx, txt, xlsx, csv, pptx, html, png or jpeg',
					},
				},
				required: ['account', 'fileId', 'path'],
				additionalProperties: false,
			},
			output: {
				schema: {
					type: 'object',
					properties: { path: { type: 'string' }, bytes: { type: 'number' } },
					required: ['path', 'bytes'],
				},
				render: (_args, value) =>
					oneText(`Saved ${value?.bytes ?? 0} bytes to ${value?.path ?? 'the requested path'}.`),
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			async execute(args, exec) {
				return await service.downloadFile(
					{
						account: args.account,
						fileId: args.fileId,
						path: resolveLocalPath(args.path, exec),
						exportFormat: args.exportFormat,
					},
					exec?.signal,
				);
			},
		},
		{
			name: 'google_drive_upload_file',
			description: 'Upload a file from this machine to Google Drive.',
			parameters: {
				type: 'object',
				properties: {
					account: { type: 'string', description: 'Name of the Google Drive account to use' },
					localPath: { type: 'string', description: 'File to upload; relative paths resolve against the workspace' },
					name: { type: 'string', description: 'Name to store the file under; defaults to the file name' },
					folderId: { type: 'string', description: 'Folder to upload into; defaults to the root' },
				},
				required: ['account', 'localPath'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object', properties: { file: FILE_SCHEMA }, required: ['file'] },
				render: (_args, value) =>
					oneText(`Uploaded ${value?.file?.name ?? 'the file'} (${value?.file?.id ?? 'unknown id'}).`),
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			async execute(args, exec) {
				return await service.uploadFile(
					{
						account: args.account,
						localPath: resolveLocalPath(args.localPath, exec),
						name: args.name,
						folderId: args.folderId,
					},
					exec?.signal,
				);
			},
		},
	];
}
