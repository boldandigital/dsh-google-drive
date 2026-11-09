/**
 * dsh-google-drive — client half (browser bundle).
 *
 * Registers a `main` page (key `google-drive`) and a `sidebar.panellist` icon
 * (id `google-drive`). The page manages Google Drive accounts (OAuth + service
 * accounts) and browses / downloads Drive files for the selected account.
 *
 * Everything the host owns is reached over the loopback Connection RPC channel
 * `/api` under the `google-drive` method namespace; see CONTRACT.md. Secrets
 * never reach the browser beyond the OAuth client id/secret the user types in.
 *
 * The stylesheet is rendered by the component itself (a `<style>` element), so
 * unmounting the panel removes it again. Only `--dsw-alias-*` / `--dsw-*`
 * custom properties are used for colours, each with a literal fallback.
 */
(function () {
	// The factory id MUST equal the package id: the module system resolves a
	// graph row's factory by its row id. Registering under another id makes the
	// bundle look like it "loaded without registering".
	window.__ModuleLoader__.load({
		id: 'dsh-google-drive',
		factory: function (require) {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
			var React = require('react');
			var h = React.createElement;

			/* onboarding wizard: the module loader's synchronous require is
			 * kept so the panel can pull in the wizard chunk with
			 * `require.async('./client.onboarding.js')`. */
			var requireFn = require;

			/** Connection's authenticated channel; the host half owns it. */
			var CHANNEL = '/api';

			/** Method namespace owned by this plugin under {@link CHANNEL}. */
			var RPC_PREFIX = 'google-drive';

			/** Slot the harness Settings renders one section per entry in. */
			var SLOT_SETTINGS = 'settings.section';

			/** Slot the section's nav glyph is rendered in. */
			var SLOT_SETTINGS_ICON = 'settings.section.icon';

			/** Own id inside those slots (MUST match the contract). */
			var PANEL_ID = 'google-drive';

			/** Locale namespace owned by this plugin. */
			var LOCALE_NS = 'google-drive';

			/** Client services this half needs. */
			var inject = ['slots', 'connection', 'locale'];

			/**
			 * The reference source's name.
			 *
			 * This is the string a chip carries as its `source`, and the
			 * submission pipeline looks the chip's owner up by it. A chip
			 * whose `source` has no registered owner with a codec rejects
			 * the whole message, so this string and the registered source's
			 * name must be the same.
			 */
			var SOURCE_NAME = 'dsh-drive';

			/** The trigger that opens the source's menu. */
			var SOURCE_TRIGGER = '@';

			/** The wire format one dragged Drive file carries. */
			var WIRE_PREFIX = 'dsh-drive:';

			/** Hint shown on a draggable file row. */
			var DRAG_HINT = 'Drag into the conversation to give this file to the agent';

			/**
			 * Escape a label so it survives the markdown link form.
			 *
			 * @param {string} label - the raw label.
			 * @returns {string} the escaped label.
			 */
			function escapeLabel(label) {
				return String(label == null ? '' : label).replace(/[\\\]]/g, function (match) {
					return '\\' + match;
				});
			}

			/**
			 * Undo the label escaping.
			 *
			 * @param {string} label - the escaped label.
			 * @returns {string} the raw label.
			 */
			function unescapeLabel(label) {
				return String(label == null ? '' : label).replace(/\\(.)/g, '$1');
			}

			/**
			 * Build the wire string one Drive file carries.
			 *
			 * The format is `@[label](dsh-drive:<account>/<fileId>)`. It is
			 * readable by a human in a draft, it cannot collide with the
			 * harness's own mention formats, and it survives a file name
			 * that contains spaces or square brackets.
			 *
			 * @param {string} account - the account the file belongs to.
			 * @param {string} fileId - the Drive file id.
			 * @param {string} label - the file name.
			 * @returns {string} the wire string.
			 */
			function wireFor(account, fileId, label) {
				return (
					'@[' +
					escapeLabel(label) +
					'](' +
					WIRE_PREFIX +
					encodeURIComponent(String(account || '')) +
					'/' +
					encodeURIComponent(String(fileId || '')) +
					')'
				);
			}

			/**
			 * The rule that recognises a wire string in the transcript.
			 *
			 * The grammar is the host's grammar, rule for rule: the label
			 * ends at the first bracket that is not escaped, and the body
			 * holds no whitespace and ends at the first bracket. A mention
			 * the browser recognises is therefore a mention the host
			 * rewrites, and a mention the host does not recognise is never
			 * left in the prompt as prose.
			 *
			 * The node it returns is a plain-text node with a display, not a
			 * business node: the harness owns the business node kinds, and
			 * claiming one would replace a shipped renderer. The raw wire
			 * stays in the draft, so the host still sees the mention and
			 * resolves it for the agent.
			 *
			 * @param {string} text - the text to search.
			 * @param {number} from - where to start searching.
			 * @returns {object|null} the match, or null.
			 */
			function matchWire(text, from) {
				if (typeof text !== 'string') return null;
				var at = text.indexOf('@[', from > 0 ? from : 0);
				while (at !== -1) {
					// `close` is the index of the bracket that ends the label.
					var close = labelEnd(text, at + 2);
					if (close !== -1 && text.slice(close, close + 2 + WIRE_PREFIX.length) === '](' + WIRE_PREFIX) {
						// The body starts after the `](` and the scheme, and runs
						// to the first bracket or the first whitespace.
						var bodyStart = close + 2 + WIRE_PREFIX.length;
						var end = bodyStart;
						while (end < text.length) {
							var ch = text.charAt(end);
							if (ch === ')' || /\s/.test(ch)) break;
							end += 1;
						}
						if (end < text.length && text.charAt(end) === ')') {
							var label = unescapeLabel(text.slice(at + 2, close));
							var body = text.slice(bodyStart, end);
							var slash = body.indexOf('/');
							// The host refuses a mention whose account or file id
							// is empty, so the browser refuses it too.
							if (slash > 0 && slash < body.length - 1) {
								return {
									id: 'text',
									start: at,
									end: end + 1,
									data: {
										text: text.slice(at, end + 1),
										display: '@' + label,
										label: label,
										account: decodeURIComponent(body.slice(0, slash)),
										fileId: decodeURIComponent(body.slice(slash + 1)),
									},
								};
							}
						}
					}
					at = text.indexOf('@[', at + 2);
				}
				return null;
			}

			/**
			 * Find the bracket that ends a mention label.
			 *
			 * A backslash escapes the character after it, so an escaped
			 * bracket is part of the label and not the end of it — the same
			 * rule the host's mention regex uses.
			 *
			 * @param {string} text - the text to scan.
			 * @param {number} from - where the label starts.
			 * @returns {number} the index of the bracket, or -1.
			 */
			function labelEnd(text, from) {
				var i = from;
				while (i < text.length) {
					var ch = text.charAt(i);
					if (ch === '\\') {
						i += 2;
						continue;
					}
					if (ch === ']') return i;
					i += 1;
				}
				return -1;
			}

			/**
			 * The model-facing text of one Drive reference.
			 *
			 * The mention itself is the model form: the host rewrites it into
			 * a neutral token and a fenced, untrusted block that names the
			 * account and the file id. The label stays in the wire — the
			 * host needs it to name the file — but it never reaches the
			 * model as prose, because a file name is attacker-controlled
			 * data. Returning anything else would leave the host nothing to
			 * resolve.
			 *
			 * @param {string} ref - the mention.
			 * @returns {string} the model-facing text.
			 */
			function serializeRef(ref) {
				return String(ref == null ? '' : ref);
			}

			/** OAuth status poll interval. */
			var OAUTH_POLL_MS = 2000;

			/** Consecutive poll failures before the OAuth flow is declared failed. */
			var OAUTH_MAX_POLL_FAILURES = 3;

			/** Export formats accepted by the host for Google-native documents. */
			var EXPORT_FORMATS = ['pdf', 'docx', 'txt', 'xlsx', 'csv', 'pptx', 'html', 'png', 'jpeg'];

			/** Extension used when a Google-native file is exported. */
			var EXPORT_EXTENSIONS = {
				pdf: '.pdf',
				docx: '.docx',
				txt: '.txt',
				xlsx: '.xlsx',
				csv: '.csv',
				pptx: '.pptx',
				html: '.html',
				png: '.png',
				jpeg: '.jpg',
			};

			/** Google-native mime prefix — these files must be exported. */
			var GOOGLE_APP_PREFIX = 'application/vnd.google-apps.';

			/**
			 * Locale dictionaries. `en` and `zh` are required and MUST keep
			 * identical key sets; the Plugin Manager metadata mirrors them from
			 * locale/en.json and locale/zh.json.
			 */
			var DICTIONARY = {
				en: {
					'panel.title': 'Google Drive',
					'settings.subtitle': 'Connect your Google Drive accounts. The files themselves live in the Drive tab of the right sidebar.',
					'common.loading': 'Loading…',
					'common.cancel': 'Cancel',
					'common.close': 'Close',
					'common.refresh': 'Refresh',
					'common.retry': 'Retry',
					'accounts.title': 'Accounts',
					'accounts.add': 'Add account',
					'accounts.empty.title': 'No Google Drive accounts yet',
					'accounts.empty.body': 'Add a Google account to browse, search and download Drive files.',
					'accounts.use': 'Use',
					'accounts.inUse': 'In use',
					'accounts.remove': 'Remove',
					'accounts.test': 'Test',
					'accounts.test.running': 'Testing the connection…',
					'accounts.test.ok': 'The connection works.',
					'accounts.test.failed': 'The connection failed: {message}',
					'accounts.edit': 'Edit',
					'accounts.adopt': 'Make editable',
					'accounts.adopt.title': 'Make this account editable',
					'accounts.adopt.body':
						'This account belongs to the Google Workspace MCP server, so its credentials cannot be changed from here. This plugin can make its own copy of the account — the server keeps the account and keeps working with it — and the copy can be renamed, re-keyed and signed in again.',
					'accounts.edit.title': 'Edit account',
					'accounts.edit.name': 'Account name',
					'accounts.edit.name.hint': 'Renaming keeps the credentials — only the name changes.',
					'accounts.edit.subject': 'Sign in as a Workspace user',
					'accounts.edit.subject.empty': 'Leave empty',
					'accounts.edit.subject.hint':
						'Only needed when your company administrator has allowed this account. A personal Google account can never do this — leave it empty and share the folder with the account instead.',
					'accounts.edit.clearSubject': 'Stop acting as a user',
					'accounts.edit.key': 'Replace the key file (optional)',
					'accounts.edit.key.hint': 'Paste a new JSON key to replace the current one. Leave empty to keep it.',
					'accounts.edit.share': 'Share files with this address',
					'accounts.edit.share.hint': 'A service account sees exactly the files that are shared with this address.',
					'accounts.edit.reauth': 'Sign in again',
					'accounts.edit.reauth.hint':
						'Grants access again with the same Google account and the same permissions. The sign-in details are already stored, so nothing else is needed.',
					'accounts.edit.reauth.action': 'Sign in again',
					'accounts.edit.reauth.ok': 'Access granted again.',
					'accounts.edit.save': 'Save changes',
					'accounts.edit.saved': 'The account was updated.',
					'browser.title': 'File browser',
					'browser.sidebarTab': 'Show the Drive tab in the right sidebar',
					'browser.sidebarTab.hint': 'The tab lists the files of a connected account next to the conversation, so a file can be dragged into it.',
					'accounts.remove.body.foreign': 'Unlink “{name}” from this plugin? The Google Workspace MCP server keeps its credentials. Remove it there to delete them.',
					'accounts.remove.title': 'Remove account?',
					'accounts.remove.body': 'Remove “{name}”? The stored credentials of this account are deleted. Files in Drive are not affected.',
					'accounts.remove.action': 'Remove',
					'accounts.type.oauth': 'OAuth',
					'accounts.type.service': 'Service account',
					'accounts.type.impersonating': 'Acting as a user',
					'accounts.foreign.badge': 'MCP',
					'accounts.foreign.shared': 'Shared',
					'accounts.foreign.note': 'Shared with the Google Workspace MCP server. You can browse it here. Removing it unlinks it from this plugin; the server keeps its credentials.',
					'accounts.added': 'Added',
					'accounts.subject': 'Acting as',
					'accounts.emailUnknown': 'Email not probed yet',
					'accounts.status.ready': 'Ready',
					'accounts.status.error': 'Error',
					'accounts.status.unknown': 'Unknown',
					'accounts.scopes': 'Scopes',
					'mcp.title': 'MCP bridge',
					'mcp.enabled': 'MCP bridge enabled',
					'mcp.disabled': 'MCP bridge disabled',
					'mcp.path': 'Mirror path',
					'mcp.installed': 'google-workspace-mcp detected',
					'mcp.notInstalled': 'google-workspace-mcp not detected',
					'storage.title': 'Secrets',
					'storage.credentials': 'Stored in the DSH credential store.',
					'storage.files': 'Stored in this plugin\u2019s own files.',
					'file.folder': 'Folder',
					'file.doc': 'Google Doc',
					'file.sheet': 'Google Sheet',
					'file.slides': 'Google Slides',
					'file.drawing': 'Google Drawing',
					'file.form': 'Google Form',
					'file.script': 'Google Script',
					'file.shortcut': 'Shortcut',
					'file.generic': 'File',
					'download.success': 'Saved to {path} ({bytes} bytes).',
					'download.failed': 'Download failed.',
					'oauth.title': 'Add account',
					'oauth.tab.oauth': 'OAuth',
					'oauth.tab.service': 'Service account',
					'oauth.name.label': 'Account name',
					'oauth.name.hint': 'Letters, digits, underscore and dash only.',
					'oauth.clientId.label': 'Client ID (from the JSON file)',
					'oauth.clientSecret.label': 'Secret (from the same JSON file)',
					'oauth.start': 'Sign in with Google',
					'oauth.link.label': 'Sign in with Google — opens in your browser',
					'oauth.link.raw': 'Sign-in link — open it in your browser if the page did not open',
					'oauth.openPage': 'Open the sign-in page',
					'oauth.openBlocked':
						'Your browser did not open the sign-in page by itself. Use the button above to open it.',
					'oauth.copy': 'Copy link',
					'oauth.copied': 'Link copied.',
					'oauth.copyFailed': 'Could not copy automatically — select the link and copy it manually.',
					'oauth.pending': 'Waiting for the sign-in to finish in your browser…',
					'oauth.authorized': 'Sign-in complete.',
					'oauth.failed': 'Authorization failed: {message}',
					'oauth.cancelFlow': 'Cancel the sign-in',
					'oauth.scope': 'This app can see, download and upload files in your Drive.',
					'service.key.label': 'Service account key (JSON)',
					'service.key.hint': 'Paste the whole file exactly as it is. It is sent to this app as text.',
					'service.subject.label': 'Sign in as (Workspace only)',
					'service.subject.hint': 'The Workspace user this account acts as. Most people should leave this empty.',
					'service.add': 'Add account',
					'wizard.title': 'Connect Google Drive',
					'wizard.progress': 'Setup progress',
					'wizard.step.label': 'Step {current} of {total}',
					'wizard.step.1': 'Choose how to connect',
					'wizard.step.2': 'Set up access',
					'wizard.step.3': 'Connected',
					'wizard.choose.title': 'How do you want to connect?',
					'wizard.choose.body': 'Most people connect their own Google account. You can add more accounts later.',
					'wizard.choose.group': 'Connection method',
					'wizard.choose.other': 'Other ways to connect',
					'wizard.choose.otherHint': 'Both of these need a Google Cloud project. Most people do not need them.',
					'wizard.option.oauth.title': 'My own Google account',
					'wizard.option.oauth.sub': 'Sign in and see your Drive files.',
					'wizard.option.oauth.hint': 'Uses a Google account.',
					'wizard.option.service.title': 'A service account',
					'wizard.option.service.sub': 'For automation. It sees only the folders you share with it.',
					'wizard.option.service.hint': 'A JSON key file.',
					'wizard.option.gcloud.title': 'Set up with Google Cloud CLI',
					'wizard.option.gcloud.sub': 'Create a key for a service account with the gcloud command line tool.',
					'wizard.option.gcloud.hint': 'Needs the gcloud CLI on this Mac.',
					'wizard.option.oauth.tag': 'Most people',
					'wizard.option.service.tag': 'No administrator needed',
					'wizard.option.workspace.title': 'My company uses Google Workspace',
					'wizard.option.workspace.sub':
						'Your administrator has to allow this app once. It can take up to a day for Google to apply it.',
					'wizard.oauth.step1': 'Create the sign-in (one time per computer)',
					'wizard.oauth.step1a':
						'Open console.cloud.google.com and sign in with your Google account. If you do not have a project yet, click “Create project” and give it any name — for example “My Drive App”.',
					'wizard.oauth.step1b':
						'Open “Google Auth Platform → Branding” — this is the OAuth consent screen. Fill in an app name you like, your own email address as the support email, and choose “External”.',
					'wizard.oauth.step1c':
						'Open “Audience” and add your own email address under “Test users”. Without that, Google refuses to sign you in later.',
					'wizard.oauth.step1d':
						'Open “Google Auth Platform → Clients” and click “Create Client”. Choose “Desktop app” — a “Web application” cannot be used here, because Google rejects its local callback.',
					'wizard.oauth.step1e':
						'Tick “Use this client for an AI-powered agent”, then click “Create” and “Download JSON”. Choose the downloaded file below — the sign-in details are filled in for you.',
					'wizard.oauth.step2': 'Sign in with Google',
					'wizard.oauth.unverified':
						'Google will show “Google hasn’t verified this app”. That is expected — this app is not published yet. Choose “Advanced” → “Go to …” to continue.',
					'wizard.oauth.testing':
						'Google only lets the accounts you listed as test users sign in while the app is in “Testing”. Add your own address under “Audience → Test users” before you press the button below.',
					'wizard.oauth.hint.unverified':
						'Google says the app is not verified: choose “Advanced” → “Go to … (unsafe)” to continue. This is expected for an app that is not published.',
					'wizard.oauth.hint.testUser':
						'Google stopped the sign-in. Most often the address is not on the app’s test-user list — but a sign-in that was cancelled looks the same. Add your address under “Audience → Test users” in the Google Cloud console, then try again.',
					'wizard.oauth.hint.redirect':
						'Google refused the redirect address. This happens when the client is a “Web application” instead of a “Desktop app”.',
					'wizard.oauth.hint.admin':
						'Your company’s administrator blocked this app. Ask the administrator to allow it.',
					'wizard.oauth.hint.orgInternal':
						'Your company limits this app to one Google Cloud organisation. Ask your administrator to allow it.',
					'wizard.oauth.hint.invalidClient':
						'The sign-in details in this app are wrong. Remove the account and add it again.',
					'wizard.oauth.hint.invalidGrant':
						'The sign-in was refused or has expired. Start it again.',
					'wizard.oauth.hint.unknown':
						'The sign-in did not go through. Check the details below, then try again.',
					'wizard.oauth.alt.shared': 'Use a shared folder instead',
					'wizard.oauth.alt.personal': 'Use my personal account',
					'wizard.oauth.scopeDetail': 'Requested permission: https://www.googleapis.com/auth/drive',
					'wizard.oauth.permissions': 'This app can see, download and upload files in your Drive.',
					'wizard.accountName.label': 'How should this account appear in the sidebar?',
					'wizard.accountName.hint': 'You can change this later. Leave it empty and your email address will be used.',
					'wizard.technical': 'Technical details',
					'wizard.service.step1': 'Create a service account',
					'wizard.service.step1a':
						'In the Google Cloud console, create a service account (IAM & Admin → Service Accounts).',
					'wizard.service.step1b': 'Open it and create a JSON key. The file is downloaded to your Mac.',
					'wizard.service.step2': 'Choose the key file',
					'wizard.service.step3': 'Name the account',
					'wizard.service.console': 'Open the service accounts page',
					'wizard.service.key.file': 'Service account key file',
					'wizard.service.pasteInstead': 'Paste the key instead',
					'wizard.service.key.filled': 'The key from {file} was filled in.',
					'wizard.service.key.badFile':
						'That file is not a service-account key. Download the JSON key of a service account.',
					'wizard.service.shareAddress':
						'Share a folder with this address to let the account see it: {email}',
					'wizard.service.shared.explain':
						'A service account can only see files you explicitly share with it — it never sees the rest of your Drive.',
					'wizard.workspace.explain':
						'Domain-wide delegation needs a real Google Workspace organisation. A personal Google account — or a company that runs its mail elsewhere — has no administrator and cannot delegate. Use “A service account” or “My own Google account” instead.',
					'wizard.workspace.step1': 'Your administrator allows this app',
					'wizard.workspace.send': 'Send this to your administrator:',
					'wizard.workspace.clientId': 'Client ID',
					'wizard.workspace.scope': 'Scope',
					'wizard.workspace.copy': 'Copy',
					'wizard.workspace.copied': 'Copied to the clipboard.',
					'wizard.workspace.delay': 'It can take up to a day for Google to apply their change.',
					'wizard.workspace.subject.hint':
						'The Workspace user this account acts as. Only your company administrator can allow this — leave it empty to use the plain shared-folder route.',
					'wizard.detect.scanning': 'Scanning this Mac for OAuth clients and gcloud…',
					'wizard.detect.scanningBrief': 'Scanning this Mac for Google sign-in details…',
					'wizard.detect.scan': 'Scan this Mac',
					'wizard.detect.rescan': 'Scan again',
					'wizard.detect.unavailable': 'Automatic setup is not available yet — use the manual steps below.',
					'wizard.detect.failed': 'Could not scan this Mac: {message}',
					'wizard.detect.timeout': 'The scan took too long. You can continue with the manual steps.',
					'wizard.detect.oauthClients': 'OAuth clients found on this Mac',
					'wizard.detect.noOAuthClients': 'No OAuth clients were found on this Mac.',
					'wizard.detect.useThis': 'Use this',
					'wizard.detect.selected': 'Selected',
					'wizard.detect.gcloudMissing': 'The gcloud command line tool is not installed on this Mac.',
					'wizard.detect.gcloudSignedOut': 'gcloud is installed but not signed in. Run “gcloud auth login” first.',
					'wizard.detect.gcloudAccount': 'Signed in as {account}',
					'wizard.detect.clientFile': 'File: {path}',
					'wizard.oauth.found.body': 'Pick one to fill in the sign-in details for you.',
					'wizard.oauth.manual.title': 'Or enter the sign-in details yourself',
					'wizard.oauth.manual.hint': 'Both values are in the JSON file you downloaded from the Google Cloud console.',
					'wizard.oauth.instructions': 'Google Cloud instructions',
					'wizard.oauth.secretHint': 'Both values are in the same downloaded file.',
					'wizard.service.gcloud.title': 'Create a key with gcloud',
					'wizard.service.gcloud.hint': 'Google creates the key and the host stores it — you never see the JSON file.',
					'wizard.service.gcloud.project': 'Google Cloud project',
					'wizard.service.gcloud.account': 'Service account',
					'wizard.service.gcloud.create': 'Create key and connect',
					'wizard.service.gcloud.otherKeys':
						'{count} older keys of this service account are still live in Google. Revoke them in the IAM console when you no longer need them.',
					'wizard.service.gcloud.noProjects': 'No Google Cloud projects were found for this gcloud account.',
					'wizard.service.gcloud.noAccounts': 'No service accounts were found in this project.',
					'wizard.service.gcloud.failed': 'Could not create the key: {message}',
					'wizard.service.manual.title': 'Add an existing key file',
					'wizard.service.manual.show': 'Add a key file manually',
					'wizard.service.manual.hide': 'Hide the manual key form',
					'wizard.done.title': 'You are connected',
					'wizard.done.body': '{name} is ready. You can browse its files now.',
					'wizard.done.generic': 'The account was added.',
					'wizard.done.action': 'Start browsing',
					'wizard.back': 'Back',
					'wizard.detect.recommended': 'Recommended',
					'wizard.detect.webClientTag': 'Not usable here',
					'wizard.detect.webClient': 'A web client cannot sign in through a local callback (http://localhost). Create a Desktop app client instead.',
					'wizard.detect.noDesktop': 'No Desktop app client was found on this Mac.',
					'wizard.desktop.title': 'Create a Desktop app client for me',
					'wizard.desktop.why': 'This plugin signs in through a local callback (http://localhost), and Google only allows that for a Desktop app client.',
					'wizard.desktop.step1': 'In the Google Cloud console, open “Google Auth Platform → Branding” and fill in the app name, the support email and “External”.',
					'wizard.desktop.step2': 'Add the scope https://www.googleapis.com/auth/drive.',
					'wizard.desktop.step3': 'Open “Google Auth Platform → Clients”, then click “Create Client”.',
					'wizard.desktop.step4': 'Choose “Desktop app” as the application type.',
					'wizard.desktop.step5': 'Tick “Use this client for an AI-powered agent”, name the client, click Create, then click “Download JSON”.',
					'wizard.desktop.step6': 'Choose the downloaded JSON file below — the client ID and secret are filled in for you.',
					'wizard.desktop.dont': 'Do not choose “Web application”: Google rejects a localhost callback for web clients.',
					'wizard.desktop.console': 'Open the Google Cloud console',
					'wizard.desktop.file': 'Choose the downloaded JSON',
					'wizard.desktop.fileHint': 'The file is read in your browser; the client ID and secret are filled into the form below and never leave this machine.',
					'wizard.desktop.filled': 'The client ID and secret were filled in from {file}.',
					'wizard.desktop.failed': 'Could not read that file: {message}',
					'wizard.desktop.noClient': 'That file does not hold the sign-in details. Download the JSON of a Desktop app client.',
					'wizard.desktop.webOnly': 'That file holds a web client, which cannot use a local callback. Create a Desktop app client instead.',
				},
				zh: {
					'panel.title': 'Google 云端硬盘',
					'settings.subtitle': '连接你的 Google 云端硬盘账号。文件本身在右侧边栏的云端硬盘标签页中浏览。',
					'common.loading': '加载中…',
					'common.cancel': '取消',
					'common.close': '关闭',
					'common.refresh': '刷新',
					'common.retry': '重试',
					'accounts.title': '账号',
					'accounts.add': '添加账号',
					'accounts.empty.title': '还没有 Google 云端硬盘账号',
					'accounts.empty.body': '添加一个 Google 账号，即可浏览、搜索并下载云端硬盘文件。',
					'accounts.use': '使用',
					'accounts.inUse': '使用中',
					'accounts.remove': '移除',
					'accounts.test': '测试',
					'accounts.test.running': '正在测试连接…',
					'accounts.test.ok': '连接正常。',
					'accounts.test.failed': '连接失败：{message}',
					'accounts.edit': '编辑',
					'accounts.adopt': '使其可编辑',
					'accounts.adopt.title': '让这个账号可以编辑',
					'accounts.adopt.body':
						'这个账号属于 Google Workspace MCP 服务器，因此不能从这里修改它的凭证。本插件可以为它建立自己的副本——服务器仍然保留并使用这个账号——而这份副本可以改名、换密钥、重新登录。',
					'accounts.edit.title': '编辑账号',
					'accounts.edit.name': '账号名称',
					'accounts.edit.name.hint': '改名不会影响凭据，只是名字变了。',
					'accounts.edit.subject': '以 Workspace 用户身份登录',
					'accounts.edit.subject.empty': '留空',
					'accounts.edit.subject.hint':
						'只有在公司管理员已允许该账号时才需要。个人 Google 账号无法这样做——请留空，改为把文件夹共享给该账号。',
					'accounts.edit.clearSubject': '停止以用户身份操作',
					'accounts.edit.key': '替换密钥文件（可选）',
					'accounts.edit.key.hint': '粘贴新的 JSON 密钥以替换当前密钥。留空则保持不变。',
					'accounts.edit.share': '用这个地址共享文件',
					'accounts.edit.share.hint': '服务账号只能看到共享给这个地址的文件。',
					'accounts.edit.reauth': '重新登录',
					'accounts.edit.reauth.hint': '用同一个 Google 账号和同样的权限重新授权。登录信息已经保存，无需再填。',
					'accounts.edit.reauth.action': '重新登录',
					'accounts.edit.reauth.ok': '已重新授权。',
					'accounts.edit.save': '保存修改',
					'accounts.edit.saved': '账号已更新。',
					'browser.title': '文件浏览器',
					'browser.sidebarTab': '在右侧边栏显示云端硬盘标签页',
					'browser.sidebarTab.hint': '该标签页在对话旁边列出已连接账号的文件，可以把文件直接拖进对话。',
					'accounts.remove.body.foreign': '把这个账号从插件中取消关联？Google Workspace MCP 服务器会保留自己的凭据。要彻底删除，请在那里操作。',
					'accounts.remove.title': '移除账号？',
					'accounts.remove.body': '要移除“{name}”吗？该账号保存的凭据会被删除，云端硬盘中的文件不受影响。',
					'accounts.remove.action': '移除',
					'accounts.type.oauth': 'OAuth',
					'accounts.type.service': '服务账号',
					'accounts.type.impersonating': '以用户身份',
					'accounts.foreign.badge': 'MCP',
					'accounts.foreign.shared': '共享',
					'accounts.foreign.note': '与 Google Workspace MCP 服务器共享。可以在这里浏览，但不能在本插件中移除。',
					'accounts.added': '添加于',
					'accounts.subject': '以谁的身份',
					'accounts.emailUnknown': '尚未探测邮箱',
					'accounts.status.ready': '就绪',
					'accounts.status.error': '异常',
					'accounts.status.unknown': '未知',
					'accounts.scopes': '权限范围',
					'mcp.title': 'MCP 桥接',
					'mcp.enabled': 'MCP 桥接已启用',
					'mcp.disabled': 'MCP 桥接已禁用',
					'mcp.path': '镜像路径',
					'mcp.installed': '已检测到 google-workspace-mcp',
					'mcp.notInstalled': '未检测到 google-workspace-mcp',
					'storage.title': '密钥存储',
					'storage.credentials': '保存在 DSH 凭据存储中。',
					'storage.files': '保存在本插件自己的文件中。',
					'file.folder': '文件夹',
					'file.doc': 'Google 文档',
					'file.sheet': 'Google 表格',
					'file.slides': 'Google 幻灯片',
					'file.drawing': 'Google 绘图',
					'file.form': 'Google 表单',
					'file.script': 'Google 脚本',
					'file.shortcut': '快捷方式',
					'file.generic': '文件',
					'download.success': '已保存到 {path}（{bytes} 字节）。',
					'download.failed': '下载失败。',
					'oauth.title': '添加账号',
					'oauth.tab.oauth': 'OAuth',
					'oauth.tab.service': '服务账号',
					'oauth.name.label': '账号名称',
					'oauth.name.hint': '只能包含字母、数字、下划线和连字符。',
					'oauth.clientId.label': '客户端 ID（来自 JSON 文件）',
					'oauth.clientSecret.label': '密钥（来自同一个 JSON 文件）',
					'oauth.start': '使用 Google 登录',
					'oauth.link.label': '使用 Google 登录——将在浏览器中打开',
					'oauth.link.raw': '登录链接——如果页面没有自动打开，请在浏览器中打开它',
					'oauth.openPage': '打开登录页面',
					'oauth.openBlocked': '浏览器没有自动打开登录页面，请用上面的按钮打开。',
					'oauth.copy': '复制链接',
					'oauth.copied': '链接已复制。',
					'oauth.copyFailed': '无法自动复制——请选中链接手动复制。',
					'oauth.pending': '正在等待浏览器中的登录完成…',
					'oauth.authorized': '登录完成。',
					'oauth.failed': '授权失败：{message}',
					'oauth.cancelFlow': '取消登录',
					'oauth.scope': '此应用可以查看、下载和上传你云端硬盘中的文件。',
					'service.key.label': '服务账号密钥（JSON）',
					'service.key.hint': '请完整原样粘贴整个文件，它会以文本形式发送到本应用。',
					'service.subject.label': '以谁的身份登录（仅限 Workspace）',
					'service.subject.hint': '此账号要代表的 Workspace 用户。大多数人应留空。',
					'service.add': '添加账号',
					'wizard.title': '连接 Google 云端硬盘',
					'wizard.progress': '设置进度',
					'wizard.step.label': '第 {current} 步，共 {total} 步',
					'wizard.step.1': '选择连接方式',
					'wizard.step.2': '设置访问权限',
					'wizard.step.3': '已连接',
					'wizard.choose.title': '你想如何连接？',
					'wizard.choose.body': '大多数人会连接自己的 Google 账号。稍后还可以添加更多账号。',
					'wizard.choose.group': '连接方式',
					'wizard.choose.other': '其他连接方式',
					'wizard.choose.otherHint': '这两种方式都需要一个 Google Cloud 项目，大多数人用不到。',
					'wizard.option.oauth.title': '我自己的 Google 账号',
					'wizard.option.oauth.sub': '登录后即可看到你的云端硬盘文件。',
					'wizard.option.oauth.hint': '使用一个 Google 账号。',
					'wizard.option.service.title': '服务账号',
					'wizard.option.service.sub': '适合自动化：它只能看到你共享给它的文件夹。',
					'wizard.option.service.hint': '需要一个 JSON 密钥文件。',
					'wizard.option.gcloud.title': '使用 Google Cloud CLI 设置',
					'wizard.option.gcloud.sub': '用 gcloud 命令行工具为服务账号创建密钥。',
					'wizard.option.gcloud.hint': '需要本机安装 gcloud CLI。',
					'wizard.option.oauth.tag': '最常见',
					'wizard.option.service.tag': '无需管理员',
					'wizard.option.workspace.title': '公司使用 Google Workspace',
					'wizard.option.workspace.sub': '需要你的管理员授权一次。Google 最多需要一天才能生效。',
					'wizard.oauth.step1': '创建登录凭据（每台电脑只需一次）',
					'wizard.oauth.step1a':
						'打开 console.cloud.google.com 并用你的 Google 账号登录。如果你还没有项目，点击“创建项目”，随便起个名字即可——例如“我的 Drive 应用”。',
					'wizard.oauth.step1b':
						'打开“Google Auth Platform → Branding”（这就是 OAuth 同意屏幕）。填写任意应用名称、把你自己的邮箱填为支持邮箱，并选择“外部”。',
					'wizard.oauth.step1c':
						'打开“目标对象”，在“测试用户”中添加你自己的邮箱地址。否则 Google 之后会拒绝你登录。',
					'wizard.oauth.step1d':
						'打开“Google Auth Platform → 客户端”并点击“创建客户端”。应用类型选择“桌面应用”——这里不能用“Web 应用”，因为 Google 会拒绝它的本地回调。',
					'wizard.oauth.step1e':
						'勾选“Use this client for an AI-powered agent”，然后点击“创建”和“下载 JSON”。在下方选择下载的文件——登录信息会自动填好。',
					'wizard.oauth.step2': '使用 Google 登录',
					'wizard.oauth.unverified':
						'Google 会显示“Google 尚未验证此应用”。这是正常的——此应用尚未正式发布。请选择“高级”→“转到 …”继续。',
					'wizard.oauth.testing':
						'当应用处于“测试”状态时，只有被列为测试用户的账号才能登录。请在按下下方按钮前，先在“目标对象→测试用户”中添加你自己的地址。',
					'wizard.oauth.hint.unverified':
						'Google 提示应用未经验证：请选择“高级”→“转到 …（不安全）”继续。未发布的应用都会这样提示。',
					'wizard.oauth.hint.testUser':
						'Google 中止了这次登录。最常见的原因是该地址不在应用的测试用户名单中——但手动取消登录时看起来一模一样。请在 Google Cloud 控制台的“目标对象→测试用户”中添加该地址，然后重试。',
					'wizard.oauth.hint.redirect':
						'Google 拒绝了回调地址。通常是因为客户端是“Web 应用”而不是“桌面应用”。',
					'wizard.oauth.hint.admin': '你所在公司的管理员阻止了此应用，请让管理员放行。',
					'wizard.oauth.hint.orgInternal': '你的公司只允许此应用属于一个 Google Cloud 组织，请让管理员放行。',
					'wizard.oauth.hint.invalidClient': '此应用中的登录信息有误。请移除该账号后重新添加。',
					'wizard.oauth.hint.invalidGrant': '本次登录被拒绝或已过期，请重新开始。',
					'wizard.oauth.hint.unknown': '登录没有完成。请查看下面的详情，然后重试。',
					'wizard.oauth.alt.shared': '改用一个共享文件夹',
					'wizard.oauth.alt.personal': '改用我的个人账号',
					'wizard.oauth.scopeDetail': '请求的权限：https://www.googleapis.com/auth/drive',
					'wizard.oauth.permissions': '此应用可以查看、下载和上传你云端硬盘中的文件。',
					'wizard.accountName.label': '这个账号在侧边栏里叫什么名字？',
					'wizard.accountName.hint': '以后可以再改。留空则使用你的邮箱地址。',
					'wizard.technical': '技术细节',
					'wizard.service.step1': '创建服务账号',
					'wizard.service.step1a': '在 Google Cloud 控制台中创建服务账号（IAM与管理→服务账号）。',
					'wizard.service.step1b': '打开它并创建 JSON 密钥，文件会下载到你的电脑。',
					'wizard.service.step2': '选择密钥文件',
					'wizard.service.step3': '为账号命名',
					'wizard.service.console': '打开服务账号页面',
					'wizard.service.key.file': '服务账号密钥文件',
					'wizard.service.pasteInstead': '改为粘贴密钥',
					'wizard.service.key.filled': '已填入来自 {file} 的密钥。',
					'wizard.service.key.badFile': '该文件不是服务账号密钥，请下载服务账号的 JSON 密钥。',
					'wizard.service.shared.explain':
						'服务账号只能看到你明确共享给它的文件——它永远看不到你云端硬盘中的其他内容。',
					'wizard.service.shareAddress': '把文件夹共享给这个地址，服务账号就能看到：{email}',
					'wizard.workspace.explain':
						'域级委派需要真正的 Google Workspace 组织。个人 Google 账号（或邮件不在 Google 的公司）没有管理员，无法委派；请改用“服务账号”或“我的 Google 账号”。',
					'wizard.workspace.step1': '由你的管理员允许此应用',
					'wizard.workspace.send': '把下面这段发给你的管理员：',
					'wizard.workspace.clientId': '客户端 ID',
					'wizard.workspace.scope': '权限范围',
					'wizard.workspace.copy': '复制',
					'wizard.workspace.copied': '已复制到剪贴板。',
					'wizard.workspace.delay': 'Google 最多需要一天才能应用管理员的更改。',
					'wizard.workspace.subject.hint':
						'此账号要代表的 Workspace 用户。只有公司管理员才能允许——留空则使用普通的共享文件夹方式。',
					'wizard.detect.scanning': '正在扫描本机的 OAuth 客户端和 gcloud…',
					'wizard.detect.scanningBrief': '正在扫描本机上的 Google 登录信息…',
					'wizard.detect.scan': '扫描这台 Mac',
					'wizard.detect.rescan': '重新扫描',
					'wizard.detect.unavailable': '自动设置尚不可用——请使用下面的手动步骤。',
					'wizard.detect.failed': '无法扫描这台 Mac：{message}',
					'wizard.detect.timeout': '扫描耗时过长。你可以继续手动设置。',
					'wizard.detect.oauthClients': '在本机找到的 OAuth 客户端',
					'wizard.detect.noOAuthClients': '本机没有找到 OAuth 客户端。',
					'wizard.detect.useThis': '使用这个',
					'wizard.detect.selected': '已选择',
					'wizard.detect.gcloudMissing': '本机没有安装 gcloud 命令行工具。',
					'wizard.detect.gcloudSignedOut': 'gcloud 已安装但尚未登录。请先运行“gcloud auth login”。',
					'wizard.detect.gcloudAccount': '已登录：{account}',
					'wizard.detect.clientFile': '文件：{path}',
					'wizard.oauth.found.body': '选择一个，即可自动填入登录信息。',
					'wizard.oauth.manual.title': '或者自己填写登录信息',
					'wizard.oauth.manual.hint': '两个值都在你从 Google Cloud 控制台下载的 JSON 文件里。',
					'wizard.oauth.instructions': 'Google Cloud 操作说明',
					'wizard.oauth.secretHint': '两个值都在同一个下载好的文件里。',
					'wizard.service.gcloud.title': '使用 gcloud 创建密钥',
					'wizard.service.gcloud.hint': '密钥由 Google 创建并由宿主保存——你不必接触 JSON 文件。',
					'wizard.service.gcloud.project': 'Google Cloud 项目',
					'wizard.service.gcloud.account': '服务账号',
					'wizard.service.gcloud.create': '创建密钥并连接',
					'wizard.service.gcloud.otherKeys':
						'该服务账号还有 {count} 个旧密钥在 Google 中仍然有效。不再需要时，请在 IAM 控制台中撤销它们。',
					'wizard.service.gcloud.noProjects': '此 gcloud 账号下没有找到 Google Cloud 项目。',
					'wizard.service.gcloud.noAccounts': '此项目中没有找到服务账号。',
					'wizard.service.gcloud.failed': '无法创建密钥：{message}',
					'wizard.service.manual.title': '使用已有的密钥文件',
					'wizard.service.manual.show': '手动添加密钥文件',
					'wizard.service.manual.hide': '隐藏手动密钥表单',
					'wizard.done.title': '连接成功',
					'wizard.done.body': '{name} 已就绪，现在可以浏览它的文件了。',
					'wizard.done.generic': '账号已添加。',
					'wizard.done.action': '开始浏览',
					'wizard.back': '返回',
					'wizard.detect.recommended': '推荐',
					'wizard.detect.webClientTag': '此处不可用',
					'wizard.detect.webClient': 'Web 客户端无法通过本地回调（http://localhost）登录，请改用桌面应用客户端。',
					'wizard.detect.noDesktop': '本机没有找到桌面应用客户端。',
					'wizard.desktop.title': '帮我创建桌面应用客户端',
					'wizard.desktop.why': '本插件通过本地回调（http://localhost）登录，而 Google 只允许桌面应用客户端使用这种回调方式。',
					'wizard.desktop.step1': '在 Google Cloud 控制台中打开“Google Auth Platform → Branding”，填写应用名称、支持邮箱并选择“外部”。',
					'wizard.desktop.step2': '添加权限范围 https://www.googleapis.com/auth/drive。',
					'wizard.desktop.step3': '打开“Google Auth Platform → 客户端”，点击“创建客户端”。',
					'wizard.desktop.step4': '应用类型选择“桌面应用”。',
					'wizard.desktop.step5': '勾选“Use this client for an AI-powered agent”，为客户端命名并点击“创建”，然后点击“下载 JSON”。',
					'wizard.desktop.step6': '在下方选择下载好的 JSON 文件——客户端 ID 和密钥会自动填好。',
					'wizard.desktop.dont': '不要选择“Web 应用”：Google 会拒绝 Web 客户端的 localhost 回调。',
					'wizard.desktop.console': '打开 Google Cloud 控制台',
					'wizard.desktop.file': '选择下载好的 JSON',
					'wizard.desktop.fileHint': '该文件只在你的浏览器中读取；客户端 ID 和密钥会填入下方表单，不会离开这台机器。',
					'wizard.desktop.filled': '已从 {file} 填入客户端 ID 和密钥。',
					'wizard.desktop.failed': '无法读取该文件：{message}',
					'wizard.desktop.noClient': '该文件不包含登录信息，请重新下载桌面应用客户端的 JSON。',
					'wizard.desktop.webOnly': '该文件是 Web 客户端，无法使用本地回调，请改用桌面应用客户端。',
				},
			};

			/* ---------------------------------------------------------------- *
			 * Small helpers (no DOM writes outside the rendered components)  *
			 * ---------------------------------------------------------------- */


			/** True for a Drive folder. */
			function isFolder(file) {
				return !!file && file.mimeType === 'application/vnd.google-apps.folder';
			}

			/**
			 * The Google-native kinds, by mime type.
			 *
			 * Drive gives a native document no file extension, so the mime
			 * type is the only thing that says whether a row is a document,
			 * a sheet or a slide deck.
			 */
			var GOOGLE_APP_KINDS = {
				'application/vnd.google-apps.folder': 'file.folder',
				'application/vnd.google-apps.document': 'file.doc',
				'application/vnd.google-apps.spreadsheet': 'file.sheet',
				'application/vnd.google-apps.presentation': 'file.slides',
				'application/vnd.google-apps.drawing': 'file.drawing',
				'application/vnd.google-apps.form': 'file.form',
				'application/vnd.google-apps.script': 'file.script',
				'application/vnd.google-apps.shortcut': 'file.shortcut',
			};

			/**
			 * The badge one file row carries.
			 *
			 * A Google-native file has no extension in its name, so it is
			 * named by its kind; an ordinary file is named by the ending of
			 * its own name, which is what the user recognises it by.
			 *
			 * @param {object} file - the Drive file.
			 * @param {function} t - the plugin's translation function.
			 * @returns {string} the badge text.
			 */
			function fileKindLabel(file, t) {
				var mimeType = (file && file.mimeType) || '';
				var native = GOOGLE_APP_KINDS[mimeType];
				if (native) return t(native);
				var name = String((file && file.name) || '');
				var dot = name.lastIndexOf('.');
				if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
				var slash = mimeType.lastIndexOf('/');
				if (slash !== -1 && mimeType.length > slash + 1) {
					return mimeType.slice(slash + 1).toUpperCase();
				}
				return t('file.generic');
			}



			/** Locale-aware date string; never throws. */
			function formatDate(value) {
				if (!value) return '—';
				try {
					var date = new Date(value);
					if (Number.isNaN(date.getTime())) return '—';
					return date.toLocaleString();
				} catch (error) {
					return '—';
				}
			}


			/* ---------------------------------------------------------------- *
			 * Stylesheet (rendered by the component, removed on unmount)     *
			 * ---------------------------------------------------------------- */

			var STYLES = [
				'.gdw{--gdw-bg:var(--dsw-alias-bg-layer-1,#fff);--gdw-soft:var(--dsw-alias-bg-layer-2,#f6f7f9);',
				'--gdw-text:var(--dsw-alias-label-primary,#1b2430);--gdw-muted:var(--dsw-alias-label-secondary,#667085);',
				'--gdw-border:var(--dsw-alias-border-l3,#e5e8ee);',
				'--gdw-accent:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb));',
				'--gdw-danger:var(--dsw-alias-state-error-primary,#b23c3c);--gdw-success:var(--dsw-alias-state-success-primary,#1f7a48);',
				'--gdw-warn:var(--dsw-alias-state-warn-primary,#8a5a00);',
				'--gdw-selected:color-mix(in srgb,var(--gdw-accent) 10%,var(--gdw-bg));',
				'color:var(--gdw-text);font:14px/1.6 var(--dsh-font-family-content,var(--dsh-font-family-text-default,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif));',
				'min-width:0;max-width:100%;box-sizing:border-box;text-align:start;color-scheme:inherit}',
				'.gdw *,.gdw *:before,.gdw *:after{box-sizing:border-box}',
				'.gdw h1,.gdw h2,.gdw h3,.gdw p{margin:0}',
				'.gdw h1{font-size:28px;line-height:1.25;font-weight:650;letter-spacing:-.02em}',
				'.gdw h2{font-size:20px;line-height:1.35;font-weight:650;overflow-wrap:anywhere}',
				'.gdw h3{font-size:15px;line-height:1.4;font-weight:600}',
				'.gdw a{color:var(--gdw-accent);text-underline-offset:3px;overflow-wrap:anywhere}',
				'.gdw button,.gdw input,.gdw select,.gdw textarea{font:inherit;color:inherit;max-width:100%}',
				'.gdw input:not([type=checkbox]):not([type=radio]),.gdw select,.gdw textarea{background:var(--dsw-specific-input-major,var(--gdw-bg));',
				'border:1px solid var(--gdw-border);border-radius:8px;padding:8px 11px;min-width:0;line-height:1.5}',
				'.gdw input:not([type=checkbox]):not([type=radio]),.gdw select{min-height:38px}',
				'.gdw textarea{resize:vertical}',
				'.gdw :focus-visible{outline:2px solid var(--gdw-accent);outline-offset:3px}',
				'.gdw button:disabled,.gdw input:disabled,.gdw select:disabled,.gdw textarea:disabled{opacity:.55;cursor:not-allowed}',
				'.gdw label{font-size:13px}',
				'.gdw-page{display:flex;flex-direction:column;min-height:480px;padding:0}',
				'.gdw-page[data-main=true]{height:100%;min-height:0;padding:calc(24px + var(--dsh-frame-top-clearance,0px)) 28px 0 max(28px,var(--dsh-frame-leading-clearance,0px));overflow:auto}',
				'.gdw-page-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:20px;flex-shrink:0}',
				'.gdw-heading{min-width:0}',
				'.gdw-subtitle{margin-top:8px!important;font-size:14px;color:var(--gdw-muted);line-height:1.6}',
				'.gdw-header-actions,.gdw-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}',
				'.gdw-header-actions{justify-content:flex-end}',
				'.gdw-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:auto}',
				'.gdw-section{padding:22px 0;border-bottom:1px solid var(--gdw-border);min-width:0}',
				'.gdw-section>h3{margin-bottom:12px}',
				'.gdw-muted{color:var(--gdw-muted);font-size:12px;line-height:1.6}',
				'.gdw-button{display:inline-flex;justify-content:center;align-items:center;gap:7px;background:var(--gdw-bg);',
				'border:1px solid var(--gdw-border);border-radius:8px;padding:8px 12px;min-height:36px;line-height:1.4;font-size:14px;',
				'font-weight:500;cursor:pointer;text-decoration:none;white-space:normal}',
				'.gdw-button:not(:disabled):hover{background:var(--gdw-soft)}',
				'.gdw-button.gdw-primary{background:var(--gdw-accent);border-color:var(--gdw-accent);color:var(--dsw-alias-label-primary-foreground,#fff)}',
				'.gdw-button.gdw-primary:not(:disabled):hover{opacity:.9}',
				'.gdw-button.gdw-ghost{background:transparent;border-color:transparent}',
				'/* The white button: white with black text, a shade dimmer on hover. */',
				'.gdw-button.gdw-light{background:#fff;border-color:var(--gdw-border);color:#000}',
				'.gdw-button.gdw-light:not(:disabled):hover{background:#e9e9e9;border-color:var(--gdw-border)}',
				'.gdw-button.gdw-danger{color:var(--gdw-danger);border-color:var(--gdw-border)}',
				'.gdw-button.gdw-danger:not(:disabled):hover{background:color-mix(in srgb,var(--gdw-danger) 10%,var(--gdw-bg))}',
				'.gdw-icon-button{width:36px;min-width:36px;padding:8px}',
				'.gdw-button svg{flex-shrink:0}',
				'.gdw-status{display:flex;align-items:flex-start;gap:8px;padding:11px 13px;margin:12px 0;border:1px solid var(--gdw-border);',
				'border-radius:8px;background:var(--gdw-soft);font-size:13px;overflow-wrap:anywhere;flex-shrink:0}',
				'.gdw-status>svg{flex-shrink:0;margin-top:2px}',
				'.gdw-status-error{color:var(--gdw-danger)}',
				'.gdw-status-success{color:var(--gdw-success)}',
				'.gdw-status-warn{color:var(--gdw-warn)}',
				'.gdw-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;',
				'width:100%;max-width:560px;padding:40px 24px;margin:auto;min-height:240px;overflow-wrap:anywhere}',
				'.gdw-empty>svg{color:var(--gdw-muted)}',
				'.gdw-empty h2{font-size:19px}',
				'.gdw-empty .gdw-muted{font-size:14px}',
				'.gdw-account{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--gdw-border);flex-wrap:wrap}',
				'.gdw-account-main{min-width:0;flex:1}',
				'.gdw-account-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
				'.gdw-account-head>strong{font-size:14px;font-weight:600;overflow-wrap:anywhere}',
				'.gdw-account-meta{margin-top:6px;color:var(--gdw-muted);font-size:12px;line-height:1.7;overflow-wrap:anywhere}',
				'.gdw-account-actions{display:flex;gap:8px;align-items:center;flex-shrink:0}',
				'.gdw-account-test{margin-top:4px}',
				'.gdw-account-error{margin-top:4px;color:var(--gdw-danger)}',
				'.gdw-account-test.gdw-account-test-ok{color:var(--gdw-success);font-weight:600}',
				'.gdw-account-test.gdw-account-test-error{color:var(--gdw-danger);font-weight:600}',
				'.gdw-account-test.gdw-account-test-testing{color:var(--gdw-muted)}',
				'.gdw-toggle{display:flex;gap:8px;align-items:center;cursor:pointer;font-size:13px;',
				'color:var(--gdw-text)}',
				'.gdw-toggle input{accent-color:var(--gdw-accent);width:15px;height:15px;cursor:pointer}',
				'.gdw-tag{font-size:12px;line-height:1.5;display:inline-flex;align-items:center;flex-shrink:0;background:var(--gdw-soft);',
				'border-radius:5px;padding:1px 6px;color:var(--gdw-muted)}',
				'.gdw-tag.gdw-tag-active{color:var(--gdw-accent);background:var(--gdw-selected)}',
				'.gdw-tag.gdw-tag-error{color:var(--gdw-danger)}',
				'.gdw-tag.gdw-tag-ok{color:var(--gdw-success)}',
				'.gdw-tag.gdw-tag-foreign{color:var(--gdw-accent);background:var(--gdw-selected);',
				'border:1px solid color-mix(in srgb,var(--gdw-accent) 30%,transparent)}',
				'.gdw-files{border:1px solid var(--gdw-border);border-radius:10px;overflow:hidden}',
				'.gdw-file{display:flex;align-items:center;gap:12px;width:100%;padding:11px 14px;border:0;border-bottom:1px solid var(--gdw-border);',
				'background:transparent;text-align:start;cursor:pointer;min-width:0}',
				'.gdw-file:last-child{border-bottom:0}',
				'.gdw-file:not(:disabled):hover{background:var(--gdw-soft)}',
				'.gdw-file-icon{width:20px;height:20px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--gdw-muted)}',
				'.gdw-file-icon>img{width:20px;height:20px;object-fit:contain}',
				'.gdw-file-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}',
				'.gdw-file-name{font-size:14px;font-weight:550;overflow-wrap:anywhere}',
				'.gdw-file-meta{color:var(--gdw-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}',
				'.gdw-file-size{color:var(--gdw-muted);font-size:12px;flex-shrink:0;font-variant-numeric:tabular-nums}',
				'.gdw-breadcrumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--gdw-muted);margin-bottom:10px}',
				'.gdw-breadcrumb>button{border:0;background:transparent;color:var(--gdw-accent);cursor:pointer;padding:2px 4px;border-radius:5px;font-size:12px}',
				'.gdw-breadcrumb>button:hover{text-decoration:underline}',
				'.gdw-fields{display:grid;gap:14px;min-width:0}',
				'.gdw-field{display:grid;gap:6px;min-width:0}',
				'.gdw-field>label{font-weight:550}',
				'.gdw-field-hint{color:var(--gdw-muted);font-size:12px;line-height:1.6}',
				'.gdw-tabs{display:flex;gap:18px;border-bottom:1px solid var(--gdw-border);margin-bottom:16px;flex-wrap:wrap}',
				'.gdw-tabs>button{border:0;border-bottom:2px solid transparent;background:transparent;padding:9px 6px 11px;font-size:14px;font-weight:550;',
				'cursor:pointer;color:var(--gdw-muted)}',
				'.gdw-tabs>button[aria-selected=true]{border-bottom-color:var(--gdw-accent);color:var(--gdw-accent)}',
				'.gdw-overlay{position:fixed;inset:0;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1b2430) 38%,transparent);',
				'display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;overflow:auto}',
				'.gdw-dialog{width:min(680px,100%);max-height:100%;display:flex;flex-direction:column;min-height:0;background:var(--gdw-bg);',
				'color:var(--gdw-text);border:1px solid var(--gdw-border);border-radius:12px;',
				'box-shadow:0 18px 70px color-mix(in srgb,var(--dsw-alias-label-primary,#1b2430) 22%,transparent)}',
				'.gdw-dialog-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 22px;border-bottom:1px solid var(--gdw-border);flex-shrink:0}',
				'.gdw-dialog-header>h2{font-size:19px}',
				'.gdw-dialog-body{overflow:auto;padding:18px 22px;min-height:0;display:flex;flex-direction:column;gap:14px}',
				'.gdw-dialog-footer{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding-top:6px}',
				'.gdw-kv{display:grid;grid-template-columns:140px minmax(0,1fr);gap:6px 12px;font-size:13px;min-width:0}',
				'.gdw-kv>dt{color:var(--gdw-muted)}',
				'.gdw-kv>dd{margin:0;overflow-wrap:anywhere}',
				'.gdw-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}',
				'.gdw-inline>input{flex:1;min-width:160px}',
				'.gdw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;overflow-wrap:anywhere}',
				'.gdw-loading{color:var(--gdw-muted);font-size:13px;padding:10px 0}',
				'.gdw-spacer{height:12px}',
				'@media(max-width:700px){.gdw-page[data-main=true]{padding:calc(16px + var(--dsh-frame-top-clearance,0px)) 16px 0 max(16px,var(--dsh-frame-leading-clearance,0px))}',
				'.gdw-overlay{padding:8px}.gdw-dialog{width:100%}.gdw-kv{grid-template-columns:1fr}.gdw-page-header{flex-wrap:wrap;gap:12px}',
				'.gdw-header-actions{justify-content:flex-start}}',
				'@media(prefers-reduced-motion:reduce){.gdw *,.gdw *:before{transition:none!important;animation:none!important}}',
			].join('');

			/* ---------------------------------------------------------------- *
			 * Icon set (own artwork, literal colours only inside the SVG)     *
			 * ---------------------------------------------------------------- */

			var ICON_PATHS = {
				drive: ['M12 2.8 21.6 19.6H2.4L12 2.8Z', 'M7.6 13.6h8.8'],
				folder: ['M3 5h7l2 3h9v12H3z'],
				file: ['M4 3h10l6 6v12H4z', 'M14 3v6h6'],
				search: ['M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z', 'm16 16 5 5'],
				plus: ['M12 5v14M5 12h14'],
				refresh: ['M20 7a9 9 0 1 0 1 8', 'M20 2v5h-5'],
				close: ['m6 6 12 12M18 6 6 18'],
				copy: ['M8 8h13v13H8z', 'M16 8V3H3v13h5'],
				download: ['M12 3v12m-5-5 5 5 5-5', 'M4 16v5h16v-5'],
				trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15'],
				info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 11v6M12 7h.01'],
				check: ['m5 12 4 4L19 6'],
				warning: ['M12 3 22 20H2L12 3Z', 'M12 9v5M12 17h.01'],
				link: ['M10 13 14 9M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0', 'm14 8 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'],
				left: ['m14 5-7 7 7 7'],
				edit: ['M4 20h4L18.5 9.5a2 2 0 0 0-3-3L4 16v4Z', 'm13.5 6.5 4 4'],
			};

			function Icon(props) {
				var name = (props && props.name) || 'file';
				var size = (props && props.size) || 18;
				var rest = {};
				for (var key in props) if (Object.prototype.hasOwnProperty.call(props, key) && key !== 'name' && key !== 'size') rest[key] = props[key];
				var paths = ICON_PATHS[name] || ICON_PATHS.file;
				return h(
					'svg',
					Object.assign(
						{
							width: size,
							height: size,
							viewBox: '0 0 24 24',
							fill: 'none',
							stroke: 'currentColor',
							strokeWidth: 1.75,
							strokeLinecap: 'round',
							strokeLinejoin: 'round',
							'aria-hidden': true,
							focusable: false,
						},
						rest,
					),
					paths.map(function (d, index) {
						return h('path', { key: index, d: d });
					}),
				);
			}

			/**
			 * Apply the plugin: register the main page, the sidebar icon and
			 * the locale dictionaries.
			 * @param {object} ctx - client plugin context.
			 */
			function apply(ctx) {
				var t = ctx.locale.bind(LOCALE_NS);

				/** Localised string, with optional {placeholder} params. */
				function tx(key, params) {
					try {
						return t(key, params);
					} catch (error) {
						return key;
					}
				}

				/**
				 * Call one host endpoint. Resolves with the endpoint value, or
				 * rejects with an Error carrying `code` and `message`.
				 */
				function rpc(endpoint, payload) {
					return Promise.resolve()
						.then(function () {
							return ctx.connection.rpc.call(CHANNEL, RPC_PREFIX + '/' + endpoint, payload || {});
						})
						.then(function (result) {
							if (result && result.ok === true) return result.value;
							var error = new Error(
								(result && result.error && result.error.message) || 'The request failed: ' + endpoint,
							);
							if (result && result.error && result.error.code) error.code = result.error.code;
							throw error;
						})
						.catch(function (error) {
							if (error instanceof Error) throw error;
							throw new Error(String((error && error.message) || error));
						});
				}

				/* ---------------------------------------------------------------- *
				 * Presentational pieces                                           *
				 * ---------------------------------------------------------------- */

				/**
				 * The Drive files the `@` menu offers.
				 *
				 * Every account is searched, so a file that lives in a second
				 * account is still reachable from the composer.
				 *
				 * @param {object} request - the menu request.
				 * @returns {Promise<object[]>} the candidates.
				 */
				function driveCandidates(request) {
					var signal = request && request.signal;
					var query = request && typeof request.query === 'string' ? request.query : '';
					return rpc('accounts/list', {})
						.then(function (list) {
							if (signal && signal.aborted) return [];
							var accounts = (list && list.accounts) || [];
							var candidates = [];
							var chain = Promise.resolve();
							accounts.forEach(function (account) {
								chain = chain.then(function () {
									if (signal && signal.aborted) return;
									return rpc('drive/search', {
										account: account.name,
										query: query,
										pageSize: 20,
									})
										.then(function (found) {
											var files = (found && found.files) || [];
											files.forEach(function (file) {
												candidates.push({
													name: file.name,
													label: file.name,
													description: account.name,
													icon: isFolder(file) ? 'folder' : 'file',
													value: {
														account: account.name,
														fileId: file.id,
														label: file.name,
														folder: isFolder(file),
													},
												});
											});
										})
										.catch(function () {
											// One account that cannot be searched
											// must not empty the whole menu.
										});
								});
							});
							return chain.then(function () {
								return candidates;
							});
						})
						.catch(function () {
							return [];
						});
				}

				function Styles() {
					return h('style', null, STYLES);
				}

				function Button(props) {
					var options = props || {};
					var children = options.children;
					var icon = options.icon;
					var variant = options.variant;
					var className = options.className;
					var rest = {};
					for (var key in options) {
						if (
							Object.prototype.hasOwnProperty.call(options, key) &&
							key !== 'children' &&
							key !== 'icon' &&
							key !== 'variant' &&
							key !== 'className'
						) {
							rest[key] = options[key];
						}
					}
					var classes = ['gdw-button'];
					if (variant) classes.push('gdw-' + variant);
					if (className) classes.push(className);
					return h(
						'button',
						Object.assign({ type: 'button', className: classes.join(' ') }, rest),
						icon ? h(Icon, { name: icon, size: 16 }) : null,
						children,
					);
				}

				function IconButton(props) {
					var options = props || {};
					var rest = {};
					for (var key in options) {
						if (Object.prototype.hasOwnProperty.call(options, key) && key !== 'label' && key !== 'icon') {
							rest[key] = options[key];
						}
					}
					rest['aria-label'] = options.label;
					rest.title = options.title || options.label;
					return h(Button, Object.assign({ icon: options.icon, className: 'gdw-icon-button' }, rest));
				}

				/**
				 * Modal dialog: focus moves in on mount, Tab is trapped, Escape
				 * closes it and focus returns to the trigger.
				 */
				function Dialog(props) {
					var options = props || {};
					var title = options.title;
					var children = options.children;
					var onClose = options.onClose;
					var busy = !!options.busy;
					var closeLabel = options.closeLabel || tx('common.close');
					var id = React.useId();
					var panel = React.useRef(null);

					React.useEffect(function () {
						var previous = document.activeElement;
						var node = panel.current;
						if (node) {
							var focusable = node.querySelector(
								'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
							);
							(focusable || node).focus({ preventScroll: true });
						}
						return function () {
							if (previous && previous.isConnected) previous.focus({ preventScroll: true });
						};
					}, []);

					function keydown(event) {
						if (event.key === 'Escape' && !event.isComposing) {
							event.preventDefault();
							event.stopPropagation();
							if (!busy) onClose();
							return;
						}
						if (event.key !== 'Tab' || !panel.current) return;
						var controls = Array.prototype.slice
							.call(
								panel.current.querySelectorAll(
									'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
								),
							)
							.filter(function (node) {
								return node.getClientRects().length;
							});
						if (!controls.length) {
							event.preventDefault();
							panel.current.focus();
							return;
						}
						var first = controls[0];
						var last = controls[controls.length - 1];
						if (event.shiftKey && document.activeElement === first) {
							event.preventDefault();
							last.focus();
						} else if (!event.shiftKey && document.activeElement === last) {
							event.preventDefault();
							first.focus();
						}
					}

					return h(
						'div',
						{
							className: 'gdw gdw-overlay',
							onClick: function (event) {
								if (!busy && event.target === event.currentTarget) onClose();
							},
						},
						h(Styles, { key: 'styles' }),
						h(
							'section',
							{
								ref: panel,
								className: 'gdw-dialog',
								role: 'dialog',
								'aria-modal': true,
								'aria-labelledby': id,
								tabIndex: -1,
								onKeyDown: keydown,
							},
							h(
								'header',
								{ className: 'gdw-dialog-header' },
								h('h2', { id: id }, title),
								h(IconButton, { icon: 'close', label: closeLabel, disabled: busy, onClick: onClose }),
							),
							h('div', { className: 'gdw-dialog-body' }, children),
						),
					);
				}

				/** Labelled form field. */
				function Field(props) {
					var options = props || {};
					var id = React.useId();
					var control;
					if (options.type === 'textarea') {
						control = h('textarea', {
							id: id,
							rows: options.rows || 8,
							value: options.value,
							placeholder: options.placeholder,
							spellCheck: false,
							onChange: options.onChange,
						});
					} else if (options.type === 'select') {
						control = h(
							'select',
							{ id: id, value: options.value, onChange: options.onChange },
							(options.options || []).map(function (option) {
								return h('option', { key: option.value, value: option.value }, option.label);
							}),
						);
					} else {
						control = h('input', {
							id: id,
							type: options.type || 'text',
							value: options.value === undefined || options.value === null ? '' : options.value,
							placeholder: options.placeholder,
							autoComplete: options.autoComplete || 'off',
							spellCheck: false,
							onChange: options.onChange,
						});
					}
					return h(
						'div',
						{ className: 'gdw-field' },
						h('label', { htmlFor: id }, options.label),
						control,
						options.hint ? h('div', { className: 'gdw-field-hint' }, options.hint) : null,
					);
				}

				/** Non-blocking status / error banner. */
				function Status(props) {
					var options = props || {};
					var tone = options.tone || 'info';
					if (!options.children) return null;
					var icon = tone === 'error' ? 'warning' : tone === 'success' ? 'check' : 'info';
					return h(
						'div',
						{
							className: 'gdw gdw-status gdw-status-' + tone,
							role: tone === 'error' ? 'alert' : 'status',
							'aria-live': tone === 'error' ? 'assertive' : 'polite',
						},
						h(Icon, { name: icon, size: 16 }),
						h('div', null, options.children),
					);
				}

				/** Empty state with an optional action. */
				function Empty(props) {
					var options = props || {};
					return h(
						'div',
						{ className: 'gdw gdw-empty' },
						h(Styles, { key: 'styles' }),
						h(Icon, { name: options.icon || 'file', size: 30 }),
						h('h2', null, options.title),
						options.children ? h('div', { className: 'gdw-muted' }, options.children) : null,
						options.action ? h('div', { className: 'gdw-toolbar' }, options.action) : null,
					);
				}

				/* ---------------------------------------------------------------- *
				 * Add-account dialog                                               *
				 * ---------------------------------------------------------------- */

				function AddAccountDialog(props) {
					var onClose = props.onClose;
					var onAdded = props.onAdded;

					/* onboarding wizard: `embedded` renders the form without
					 * its own modal, so the wizard can host the very same
					 * OAuth / service-account form inside its second step. */
					var embedded = !!props.embedded;
					var mode = props.mode || 'oauth';

					var [tab, setTab] = React.useState('oauth');
					var [name, setName] = React.useState('');
					var [clientId, setClientId] = React.useState(props.initialClientId || '');
					var [clientSecret, setClientSecret] = React.useState('');
					var [keyJson, setKeyJson] = React.useState('');
					var [subject, setSubject] = React.useState('');
					var [busy, setBusy] = React.useState(false);
					var [error, setError] = React.useState('');

					/* OAuth flow state: idle | starting | pending | authorized | failed */
					var [oauth, setOauth] = React.useState({ state: 'idle' });
					var flowRef = React.useRef(null);
					var linkRef = React.useRef(null);
					var [copied, setCopied] = React.useState('');

					var pollFailures = React.useRef(0);

					/* onboarding wizard: the wizard can prefill the client id with
					 * one of the OAuth clients it found on this Mac, and the
					 * client secret with the one of a downloaded JSON file. */
					React.useEffect(function () {
						if (props.initialClientId) setClientId(props.initialClientId);
					}, [props.initialClientId]);
					React.useEffect(function () {
						if (props.initialName && !name) setName(props.initialName);
					}, [props.initialName]);
					React.useEffect(function () {
						if (props.initialClientSecret) setClientSecret(props.initialClientSecret);
					}, [props.initialClientSecret]);

					/* Poll oauth/status until the flow is authorized or failed. */
					React.useEffect(function () {
						if (oauth.state !== 'pending' || !flowRef.current) return undefined;
						var alive = true;
						var timer = null;

						function poll() {
							rpc('oauth/status', { flowId: flowRef.current })
								.then(function (value) {
									if (!alive) return;
									pollFailures.current = 0;
									var status = value && value.status;
									if (status === 'authorized') {
										setOauth({ state: 'authorized', account: value.account || null });
										onAdded(value.account || null);
										onClose();
										return;
									}
									if (status === 'failed') {
										setOauth({
											state: 'failed',
											message: (value && value.message) || tx('oauth.failed', { message: '' }),
										});
										return;
									}
								})
								.catch(function (pollError) {
									if (!alive) return;
									pollFailures.current += 1;
									if (pollFailures.current >= OAUTH_MAX_POLL_FAILURES) {
										setOauth({ state: 'failed', message: pollError.message });
									}
								});
						}

						timer = setInterval(poll, OAUTH_POLL_MS);
						return function () {
							alive = false;
							if (timer) clearInterval(timer);
						};
					}, [oauth.state]);

					function startAuthorization() {
						if (busy) return;
						setError('');
						setOauth({ state: 'starting' });
						setBusy(true);
						rpc('oauth/start', {
							name: name.trim(),
							clientId: clientId.trim(),
							clientSecret: clientSecret,
						})
							.then(function (value) {
								flowRef.current = (value && value.flowId) || null;
								pollFailures.current = 0;
								if (!flowRef.current) {
									setOauth({ state: 'failed', message: tx('oauth.failed', { message: '' }) });
									return;
								}
								setOauth({ state: 'pending', authUrl: (value && value.authUrl) || '' });
							})
							.catch(function (startError) {
								setOauth({ state: 'failed', message: startError.message });
							})
							.finally(function () {
								setBusy(false);
							});
					}

					function cancelAuthorization() {
						var flowId = flowRef.current;
						setOauth({ state: 'idle' });
						flowRef.current = null;
						if (!flowId) return;
						rpc('oauth/cancel', { flowId: flowId }).catch(function () {
							/* Cancelling is best-effort: the host expires the flow anyway. */
						});
					}

					function copyLink() {
						var url = oauth.authUrl || '';
						if (!url) return;
						var clipboard = typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
						if (clipboard && clipboard.writeText) {
							clipboard.writeText(url).then(
								function () {
									setCopied('copied');
								},
								function () {
									setCopied('failed');
								},
							);
							return;
						}
						if (linkRef.current) {
							linkRef.current.focus();
							linkRef.current.select();
						}
						setCopied('failed');
					}

					function addServiceAccount() {
						if (busy) return;
						setError('');
						setBusy(true);
						rpc('accounts/add-service', {
							name: name.trim(),
							keyJson: keyJson,
							subject: subject.trim() ? subject.trim() : undefined,
						})
							.then(function (value) {
								onAdded((value && value.account) || null);
								onClose();
							})
							.catch(function (addError) {
								setError(addError.message);
							})
							.finally(function () {
								setBusy(false);
							});
					}

					function oauthPanel() {
						return h(
							'div',
							{ className: 'gdw-fields' },
							h(Field, {
								label: tx('oauth.name.label'),
								value: name,
								hint: tx('oauth.name.hint'),
								onChange: function (event) {
									setName(event.target.value);
								},
							}),
							h(Field, {
								label: tx('oauth.clientId.label'),
								value: clientId,
								onChange: function (event) {
									setClientId(event.target.value);
								},
							}),
							h(Field, {
								label: tx('oauth.clientSecret.label'),
								type: 'password',
								value: clientSecret,
								onChange: function (event) {
									setClientSecret(event.target.value);
								},
							}),
							h('div', { className: 'gdw-field-hint' }, tx('oauth.scope')),
							h(
								'div',
								{ className: 'gdw-toolbar' },
								h(
									Button,
									{
										variant: 'primary',
										icon: 'link',
										disabled: busy || !name.trim() || !clientId.trim() || !clientSecret,
										onClick: startAuthorization,
									},
									tx('oauth.start'),
								),
								oauth.state === 'pending'
									? h(Button, { variant: 'ghost', onClick: cancelAuthorization }, tx('oauth.cancelFlow'))
									: null,
							),
							oauth.state === 'pending'
								? h(Status, { tone: 'info' }, tx('oauth.pending'))
								: null,
							oauth.state === 'failed'
								? h(
										Status,
										{ tone: 'error' },
										tx('oauth.failed', { message: oauth.message || '' }),
									)
								: null,
							oauth.state === 'authorized'
								? h(Status, { tone: 'success' }, tx('oauth.authorized'))
								: null,
							oauth.authUrl
								? h(
										'div',
										{ className: 'gdw-field' },
										h('label', null, tx('oauth.link.raw')),
										h(
											'div',
											{ className: 'gdw-inline' },
											h('input', {
												ref: linkRef,
												type: 'text',
												readOnly: true,
												className: 'gdw-mono',
												value: oauth.authUrl,
												onFocus: function (event) {
													event.target.select();
												},
											}),
											h(Button, { icon: 'copy', onClick: copyLink }, tx('oauth.copy')),
										),
										h(
											'a',
											{
												href: oauth.authUrl,
												target: '_blank',
												rel: 'noreferrer noopener',
												className: 'gdw-mono',
											},
											oauth.authUrl,
										),
										copied === 'copied' ? h('div', { className: 'gdw-field-hint' }, tx('oauth.copied')) : null,
										copied === 'failed' ? h('div', { className: 'gdw-field-hint' }, tx('oauth.copyFailed')) : null,
									)
								: null,
						);
					}

					function servicePanel() {
						return h(
							'div',
							{ className: 'gdw-fields' },
							h(Field, {
								label: tx('oauth.name.label'),
								value: name,
								hint: tx('oauth.name.hint'),
								onChange: function (event) {
									setName(event.target.value);
								},
							}),
							h(Field, {
								label: tx('service.key.label'),
								type: 'textarea',
								rows: 10,
								value: keyJson,
								placeholder: '{ "type": "service_account", … }',
								hint: tx('service.key.hint'),
								onChange: function (event) {
									setKeyJson(event.target.value);
								},
							}),
							h(Field, {
								label: tx('service.subject.label'),
								value: subject,
								hint: tx('service.subject.hint'),
								onChange: function (event) {
									setSubject(event.target.value);
								},
							}),
							h(
								'div',
								{ className: 'gdw-toolbar' },
								h(
									Button,
									{
										variant: 'primary',
										disabled: busy || !name.trim() || !keyJson.trim(),
										onClick: addServiceAccount,
									},
									tx('service.add'),
								),
							),
						);
					}

					/* onboarding wizard: inside the wizard the form is hosted by
					 * the wizard's own dialog, so only the form is rendered. */
					if (embedded) {
						return h(
							'div',
							{ className: 'gdw-fields' },
							error ? h(Status, { tone: 'error' }, error) : null,
							mode === 'service' ? servicePanel() : oauthPanel(),
						);
					}

					return h(
						Dialog,
						{ title: tx('oauth.title'), onClose: onClose, busy: busy },
						h(
							'div',
							{ className: 'gdw-tabs', role: 'tablist', 'aria-label': tx('oauth.title') },
							h(
								'button',
								{
									type: 'button',
									role: 'tab',
									'aria-selected': tab === 'oauth',
									onClick: function () {
										setTab('oauth');
									},
								},
								tx('oauth.tab.oauth'),
							),
							h(
								'button',
								{
									type: 'button',
									role: 'tab',
									'aria-selected': tab === 'service',
									onClick: function () {
										setTab('service');
									},
								},
								tx('oauth.tab.service'),
							),
						),
						error ? h(Status, { tone: 'error' }, error) : null,
						tab === 'oauth' ? oauthPanel() : servicePanel(),
						h(
							'div',
							{ className: 'gdw-dialog-footer' },
							h(Button, { variant: 'ghost', onClick: onClose, disabled: busy }, tx('common.cancel')),
						),
					);
				}

				/* ---------------------------------------------------------------- *
				 * Edit-account dialog                                                 *
				 * ---------------------------------------------------------------- */

				/**
				 * The dialog that changes an account that was already added.
				 *
				 * An account is not a one-way door. This dialog is where it is
				 * renamed, where a rotated key is pasted, where the Workspace
				 * user a service account acts as is changed or taken away, and
				 * where an expired Google sign-in is renewed without the
				 * user having to find the OAuth client again.
				 *
				 * @param {object} props - the component props.
				 * @returns {object} the React element.
				 */
				function EditAccountDialog(props) {
					var account = props.account;
					var onClose = props.onClose;
					var onSaved = props.onSaved;
					/* Signing in again renews the account. It is not a save, so it
					 * must not close the dialog: whatever the user typed and did
					 * not save would be thrown away with it. */
					var onReauthorized = props.onReauthorized;

					var isService = account.type === 'service_account';

					var [name, setName] = React.useState(account.name);
					var [subject, setSubject] = React.useState(account.subject || '');
					var [keyJson, setKeyJson] = React.useState('');
					var [busy, setBusy] = React.useState(false);
					var [error, setError] = React.useState('');
					var [saved, setSaved] = React.useState(false);

					/* The re-authorisation flow: idle | starting | pending | failed */
					var [reauth, setReauth] = React.useState({ state: 'idle' });
					var flowRef = React.useRef(null);
					var pollFailures = React.useRef(0);

					/* The re-authorisation polls the host until Google answers. */
					React.useEffect(function () {
						if (reauth.state !== 'pending' || !flowRef.current) return undefined;
						var alive = true;
						var timer = null;

						function poll() {
							rpc('oauth/status', { flowId: flowRef.current })
								.then(function (value) {
									if (!alive) return;
									pollFailures.current = 0;
									var status = value && value.status;
									if (status === 'authorized') {
										setReauth({ state: 'authorized' });
										/* Signing in again renews the account; it is not a
										 * save. Closing the dialog here would throw away
										 * whatever the user typed and did not save. */
										if (onReauthorized) onReauthorized(value.account || null);
										return;
									}
									if (status === 'failed') {
										setReauth({
											state: 'failed',
											message: (value && value.message) || tx('oauth.failed', { message: '' }),
										});
									}
								})
								.catch(function (pollError) {
									if (!alive) return;
									pollFailures.current += 1;
									if (pollFailures.current >= OAUTH_MAX_POLL_FAILURES) {
										setReauth({ state: 'failed', message: pollError.message });
									}
								});
						}

						timer = setInterval(poll, OAUTH_POLL_MS);
						return function () {
							alive = false;
							if (timer) clearInterval(timer);
						};
					}, [reauth.state]);

					/**
					 * Start a new sign-in for this account.
					 *
					 * The OAuth client the account was created with is stored
					 * with it, so the renewal needs nothing but this click.
					 */
					function startReauthorization() {
						if (busy) return;
						setError('');
						setReauth({ state: 'starting' });
						setBusy(true);
						rpc('oauth/start', { name: account.name, useStored: true })
							.then(function (value) {
								flowRef.current = (value && value.flowId) || null;
								pollFailures.current = 0;
								if (!flowRef.current) {
									setReauth({ state: 'failed', message: tx('oauth.failed', { message: '' }) });
									return;
								}
								setReauth({ state: 'pending', authUrl: (value && value.authUrl) || '' });
							})
							.catch(function (startError) {
								setReauth({ state: 'failed', message: startError.message });
							})
							.finally(function () {
								setBusy(false);
							});
					}

					/**
					 * Write the changes back to the host.
					 */
					function save() {
						if (busy) return;
						setError('');
						var payload = { name: account.name };
						var wanted = name.trim();
						if (wanted && wanted !== account.name) payload.newName = wanted;
						if (isService) {
							/* The subject is always sent for a service account,
							 * so clearing the field really clears it. */
							payload.subject = subject.trim();
							if (keyJson.trim()) payload.keyJson = keyJson.trim();
						}
						setBusy(true);
						rpc('accounts/update', payload)
							.then(function (value) {
								setSaved(true);
								if (onSaved) onSaved((value && value.account) || null);
							})
							.catch(function (saveError) {
								setError(saveError.message);
							})
							.finally(function () {
								setBusy(false);
							});
					}

					var nameChanged = name.trim() !== '' && name.trim() !== account.name;
					var subjectChanged = isService && subject.trim() !== (account.subject || '');
					var keyChanged = isService && keyJson.trim() !== '';
					var hasChanges = nameChanged || subjectChanged || keyChanged;

					return h(
						Dialog,
						{ title: tx('accounts.edit.title'), onClose: onClose, busy: busy },
						error ? h(Status, { tone: 'error' }, error) : null,
						saved ? h(Status, { tone: 'success' }, tx('accounts.edit.saved')) : null,
						h(
							'div',
							{ className: 'gdw-fields' },
							h(Field, {
								label: tx('accounts.edit.name'),
								value: name,
								hint: tx('accounts.edit.name.hint'),
								onChange: function (event) {
									setName(event.target.value);
								},
							}),
							isService
								? h(
										'div',
										{ className: 'gdw-field' },
										h('label', { htmlFor: 'gdw-edit-subject' }, tx('accounts.edit.subject')),
										h('input', {
											id: 'gdw-edit-subject',
											type: 'text',
											value: subject,
											placeholder: tx('accounts.edit.subject.empty'),
											onChange: function (event) {
												setSubject(event.target.value);
											},
										}),
										h('div', { className: 'gdw-field-hint' }, tx('accounts.edit.subject.hint')),
										account.subject
											? h(
													'div',
													{ className: 'gdw-toolbar' },
													h(
														Button,
														{
															onClick: function () {
																setSubject('');
															},
														},
														tx('accounts.edit.clearSubject'),
													),
												)
											: null,
									)
								: null,
							isService
								? h(
										'div',
										{ className: 'gdw-field' },
										h('label', null, tx('accounts.edit.key')),
										h('textarea', {
											rows: 6,
											value: keyJson,
											placeholder: '{ "type": "service_account", … }',
											spellCheck: false,
											onChange: function (event) {
												setKeyJson(event.target.value);
											},
										}),
										h('div', { className: 'gdw-field-hint' }, tx('accounts.edit.key.hint')),
									)
								: null,
							isService && account.email && !account.subject
								? h(
										'div',
										{ className: 'gdw-field' },
										h('div', { className: 'gdw-field-hint' }, tx('accounts.edit.share')),
										h('div', { className: 'gdw-mono' }, account.email),
										h('div', { className: 'gdw-field-hint' }, tx('accounts.edit.share.hint')),
									)
								: null,
							!isService
								? h(
										'div',
										{ className: 'gdw-field' },
										h('h3', null, tx('accounts.edit.reauth')),
										h('div', { className: 'gdw-field-hint' }, tx('accounts.edit.reauth.hint')),
										h(
											'div',
											{ className: 'gdw-toolbar' },
											h(
												Button,
												{
													icon: 'link',
													disabled: busy || reauth.state === 'starting' || reauth.state === 'pending',
													onClick: startReauthorization,
												},
												tx('accounts.edit.reauth.action'),
											),
										),
										reauth.state === 'pending'
											? h(Status, { tone: 'info' }, tx('oauth.pending'))
											: null,
										reauth.state === 'failed'
											? h(
													Status,
													{ tone: 'error' },
													tx('oauth.failed', { message: reauth.message || '' }),
												)
											: null,
										reauth.state === 'authorized'
											? h(Status, { tone: 'success' }, tx('accounts.edit.reauth.ok'))
											: null,
										reauth.authUrl
											? h(
													'div',
													{ className: 'gdw-inline' },
													h(
														'a',
														{
															href: reauth.authUrl,
															target: '_blank',
															rel: 'noreferrer noopener',
															className: 'gdw-mono',
														},
														tx('oauth.link.raw'),
													),
												)
											: null,
									)
								: null,
						),
						h(
							'div',
							{ className: 'gdw-dialog-footer' },
							h(
								Button,
								{ variant: 'ghost', disabled: busy, onClick: onClose },
								tx('common.cancel'),
							),
							h(
								Button,
								{ variant: 'primary', disabled: busy || !hasChanges, onClick: save },
								tx('accounts.edit.save'),
							),
						),
					);
				}

				/* ---------------------------------------------------------------- *
				 * File details dialog                                                *
				 * ---------------------------------------------------------------- */

	
				/* ---------------------------------------------------------------- *
				 * The panel                                                         *
				 * ---------------------------------------------------------------- */

				/**
				 * The settings section.
				 *
				 * The plugin owns no left-sidebar icon and no full-screen page:
				 * the accounts live here, under the harness Settings, and the
				 * files live in the right sidebar next to the conversation, where
				 * they can be dragged into it.
				 *
				 * @returns {object} the React element.
				 */
				function GoogleDriveSettings() {
					var [accounts, setAccounts] = React.useState(null);
					var [accountsError, setAccountsError] = React.useState('');
					var [mcp, setMcp] = React.useState(null);
					var [storage, setStorage] = React.useState(null);
					/* The locale revision only exists to re-render the section when
					 * the language changes. */
					var [, setLocaleRevision] = React.useState(0);

					var [dialog, setDialog] = React.useState(null);
					var [removing, setRemoving] = React.useState(false);
					var [adopting, setAdopting] = React.useState(false);
					/* Which tab of the section is open: the accounts, or adding one. */
					var [tab, setTab] = React.useState('accounts');
					/* The result of each connection test, by account name. */
					var [tests, setTests] = React.useState({});
					/* Whether the Drive tab sits in the right sidebar. */
					var [sidebarTab, setSidebarTabState] = React.useState(true);

					/* onboarding wizard: the wizard itself lives in its own browser
					 * chunk; it is loaded in the background so the "Add account"
					 * button can open it. */
					var [onboarding, setOnboarding] = React.useState(null);
					var [onboardingError, setOnboardingError] = React.useState('');

					/* Locale changes re-render the section. */
					React.useEffect(function () {
						if (!ctx.locale || typeof ctx.locale.subscribe !== 'function') return undefined;
						return ctx.locale.subscribe(function () {
							setLocaleRevision(function (value) {
								return value + 1;
							});
						});
					}, []);

					/* onboarding wizard: pull the wizard chunk in. A chunk that cannot
					 * be loaded is not fatal: the legacy add-account dialog takes
					 * over. */
					React.useEffect(function () {
						var alive = true;
						requireFn.async('./client.onboarding.js').then(
							function (module) {
								if (alive) setOnboarding(module);
							},
							function (loadError) {
								if (!alive) return;
								setOnboardingError(
									loadError && loadError.message ? loadError.message : String(loadError),
								);
							},
						);
						return function () {
							alive = false;
						};
					}, []);

					/* onboarding wizard: the wizard component, built from the chunk
					 * with the pieces it shares with this bundle. */
					var OnboardingWizard = React.useMemo(
						function () {
							if (!onboarding || typeof onboarding.createOnboardingWizard !== 'function') return null;
							return onboarding.createOnboardingWizard({
								React: React,
								h: h,
								tx: tx,
								rpc: rpc,
								Button: Button,
								Field: Field,
								Status: Status,
								Dialog: Dialog,
								Icon: Icon,
								AddAccountDialog: AddAccountDialog,
							});
						},
						[onboarding],
					);

					/**
					 * Read the plugin's own preferences.
					 *
					 * @returns {Promise<object>} the preferences.
					 */
					function loadPreferences() {
						return rpc('settings/get', {})
							.then(function (value) {
								var enabled = !(value && value.sidebarTab === false);
								setSidebarTabState(enabled);
								setSidebarTab(enabled);
								return value;
							})
							.catch(function () {
								return null;
							});
					}

					/**
					 * Turn the right-sidebar Drive tab on or off.
					 *
					 * @param {boolean} enabled - whether the tab should be there.
					 */
					function toggleSidebarTab(enabled) {
						rpc('settings/set', { sidebarTab: enabled })
							.then(function (value) {
								var next = !(value && value.sidebarTab === false);
								setSidebarTabState(next);
								setSidebarTab(next);
							})
							.catch(function (error) {
								setAccountsError(error.message);
							});
					}

					/**
					 * Check that one connection still works.
					 *
					 * @param {object} account - the account to test.
					 */
					function testAccount(account) {
						setTests(function (current) {
							var next = {};
							for (var key in current) {
								if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
							}
							next[account.name] = { state: 'testing', message: '' };
							return next;
						});
						rpc('accounts/test', { name: account.name })
							.then(function (value) {
								setTests(function (current) {
									var next = {};
									for (var key in current) {
										if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
									}
									next[account.name] = {
										state: 'ok',
										message: tx('accounts.test.ok'),
									};
									return next;
								});
							})
							.catch(function (error) {
								setTests(function (current) {
									var next = {};
									for (var key in current) {
										if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
									}
									next[account.name] = {
										state: 'error',
										message: error.message,
									};
									return next;
								});
							});
					}

					function loadAccounts() {
						setAccountsError('');
						/* The probe is asked for: the settings section wants to know
						 * whether an account really signs in. */
						return rpc('accounts/list', { probe: true })
							.then(function (value) {
								var list = (value && value.accounts) || [];
								setAccounts(list);
								setMcp((value && value.mcpBridge) || null);
								setStorage((value && value.storage) || null);
								return list;
							})
							.catch(function (error) {
								setAccountsError(error.message);
								setAccounts([]);
								return [];
							});
					}

					React.useEffect(function () {
						loadAccounts();
						loadPreferences();
					}, []);

					/**
					 * Remove one account and the credentials it owns.
					 *
					 * @param {object} account - the account to remove.
					 */
					function removeAccount(account) {
						if (removing) return;
						setRemoving(true);
						rpc('accounts/remove', { name: account.name })
							.then(function () {
								setDialog(null);
								return loadAccounts();
							})
							.catch(function (error) {
								setAccountsError(error.message);
							})
							.finally(function () {
								setRemoving(false);
							});
					}

					/**
					 * Take an account the Google Workspace MCP server owns into this
					 * plugin.
					 *
					 * The credentials of such an account are the server's, so this
					 * plugin may not rename it or replace its key. What it can do is
					 * make a copy of its own — the same private copy every account
					 * added here gets — and that copy can be edited. The server keeps
					 * the account and keeps working with it: the shared file still
					 * holds it, pointing at the copy.
					 *
					 * @param {object} account - the account to take over.
					 */
					function adoptAccount(account) {
						if (adopting) return;
						setAdopting(true);
						setAccountsError('');
						rpc('accounts/adopt', { name: account.name })
							.then(function (value) {
								return loadAccounts().then(function () {
									/* The copy belongs to this plugin now, so it opens in
									 * the editor straight away. */
									var owned = (value && value.account) || null;
									if (owned) setDialog({ type: 'edit', account: owned });
								});
							})
							.catch(function (error) {
								setAccountsError(error.message);
							})
							.finally(function () {
								setAdopting(false);
							});
					}

					function accountBadge(account) {
						if (account.type === 'service_account') {
							return account.subject ? tx('accounts.type.impersonating') : tx('accounts.type.service');
						}
						if (account.type === 'oauth') return tx('accounts.type.oauth');
						return '';
					}

					/**
					 * An account that belongs to the Google Workspace MCP server rather
					 * than to this plugin. It is listed, but read-only here: the host
					 * refuses to remove it.
					 *
					 * @param {object} account - the account.
					 * @returns {boolean} whether the account belongs elsewhere.
					 */
					function isForeign(account) {
						return !!(account && account.foreign === true);
					}

					function accountStatusClass(account) {
						if (account.status === 'ready') return 'gdw-tag gdw-tag-ok';
						if (account.status === 'error') return 'gdw-tag gdw-tag-error';
						return 'gdw-tag';
					}

					/** The three status values the contract defines; anything else is unknown. */
					function accountStatusKey(account) {
						if (account.status === 'ready') return 'ready';
						if (account.status === 'error') return 'error';
						return 'unknown';
					}

					/**
					 * One account row.
					 *
					 * @param {object} account - the account to render.
					 * @returns {object} the React element.
					 */
					function renderAccount(account) {
						var test = tests[account.name];
						return h(
							'div',
							{ className: 'gdw-account', key: account.name },
							h(
								'div',
								{ className: 'gdw-account-main' },
								h(
									'div',
									{ className: 'gdw-account-head' },
									h('strong', null, account.name),
									accountBadge(account) ? h('span', { className: 'gdw-tag' }, accountBadge(account)) : null,
									isForeign(account) ? h('span', { className: 'gdw-tag gdw-tag-foreign' }, tx('accounts.foreign.badge')) : null,
									isForeign(account) ? h('span', { className: 'gdw-tag gdw-tag-foreign' }, tx('accounts.foreign.shared')) : null,
									h('span', { className: accountStatusClass(account) }, tx('accounts.status.' + accountStatusKey(account))),
								),
								h(
									'div',
									{ className: 'gdw-account-meta' },
									(account.email ? account.email : tx('accounts.emailUnknown')) +
										' · ' +
										tx('accounts.added') +
										' ' +
										formatDate(account.addedAt) +
										(account.subject ? ' · ' + tx('accounts.subject') + ': ' + account.subject : '') +
										(account.scopes && account.scopes.length ? ' · ' + tx('accounts.scopes') + ': ' + account.scopes.join(', ') : ''),
								),
								isForeign(account)
									? h('div', { className: 'gdw-account-meta' }, tx('accounts.foreign.note'))
									: null,
								/* When the credentials do not work, the host says why. That
									 * reason is the whole point of the account list, so it is
									 * shown rather than hidden behind a red tag. */
								account.error
									? h('div', { className: 'gdw-account-meta gdw-account-error' }, account.error)
									: null,
								test
									? h(
											'div',
											{
												className:
													'gdw-account-meta gdw-account-test gdw-account-test-' + test.state,
											},
											test.state === 'testing'
												? tx('accounts.test.running')
												: test.state === 'ok'
													? tx('accounts.test.ok')
													: tx('accounts.test.failed', { message: test.message }),
										)
									: null,
							),
							h(
								'div',
								{ className: 'gdw-account-actions' },
																/* An account this plugin owns can be changed: renamed,
								 * re-authorised, or given another key. An account the
								 * upstream MCP server owns cannot — its credentials are
								 * the server's — so it offers no edit button. */
								isForeign(account)
									? null
									: h(
											Button,
											{
												icon: 'edit',
												onClick: function () {
													setDialog({ type: 'edit', account: account });
												},
											},
											tx('accounts.edit'),
										),
								/* An account the upstream server owns can be taken into this
								 * plugin: the plugin makes a copy of its own, and that copy can be
								 * edited like any account added here. */
								isForeign(account)
								? h(
								Button,
								{
								disabled: adopting,
								onClick: function () {
								adoptAccount(account);
								},
								},
								tx('accounts.adopt'),
								)
								: null,
/* Every account carries the action. An account the
								 * Google Workspace MCP server owns cannot have its
								 * credentials deleted from here — they are the
								 * server's, and a key file can be shared with another
								 * account — so removing one unlinks it from this plugin
								 * and says so. */
								h(
									Button,
									{
										disabled: test && test.state === 'testing',
										onClick: function () {
											testAccount(account);
										},
									},
									tx('accounts.test'),
								),
								h(
									Button,
									{
										variant: 'danger',
										icon: 'trash',
										onClick: function () {
											setDialog({ type: 'remove', account: account });
										},
									},
									tx('accounts.remove'),
								),
							),
						);
					}

					var accountsList = accounts || [];
					var body = [];

					/* The add-account tab: the wizard, in the section itself
					 * rather than in a dialog of its own. */
					if (tab === 'add') {
						body.push(
							h(
								'section',
								{ className: 'gdw-section', key: 'add' },
								OnboardingWizard
									? h(OnboardingWizard, {
											key: 'add-wizard',
											embedded: true,
											onClose: function () {
												setTab('accounts');
											},
											onAdded: function () {
												loadAccounts();
											},
										})
									: onboardingError
										? h(AddAccountDialog, {
												key: 'add-legacy',
												onClose: function () {
													setTab('accounts');
												},
												onAdded: function () {
													loadAccounts();
												},
											})
										: h('div', { className: 'gdw-loading' }, tx('common.loading')),
							),
						);
						return h(
							'section',
							{ className: 'gdw gdw-settings' },
							h(Styles, { key: 'styles' }),
							h(
								'header',
								{ className: 'gdw-page-header' },
								h(
									'div',
									{ className: 'gdw-heading' },
									h('h1', null, tx('panel.title')),
									h('p', { className: 'gdw-subtitle' }, tx('settings.subtitle')),
								),
								h(
									'div',
									{ className: 'gdw-header-actions' },
									h(
										Button,
										{
											variant: 'ghost',
											icon: 'left',
											onClick: function () {
												setTab('accounts');
											},
										},
										tx('common.cancel'),
									),
								),
							),
							h('div', { className: 'gdw-body' }, body),
						);
					}

					body.push(
						h(
							'section',
							{ className: 'gdw-section', key: 'browser' },
							h('h3', null, tx('browser.title')),
							h(
								'label',
								{ className: 'gdw-toggle' },
								h(
										'input',
									{
										type: 'checkbox',
										checked: sidebarTab,
										onChange: function (event) {
											toggleSidebarTab(!!event.target.checked);
										},
									},
								),
								h('span', null, tx('browser.sidebarTab')),
							),
							h('p', { className: 'gdw-muted' }, tx('browser.sidebarTab.hint')),
						),
					);

					body.push(
						h(
							'section',
							{ className: 'gdw-section', key: 'accounts' },
							h('h3', null, tx('accounts.title')),
							accounts === null && !accountsError
								? h('div', { className: 'gdw-loading' }, tx('common.loading'))
								: null,
							accounts !== null && !accountsError && !accountsList.length
								? h(
										Empty,
										{
											title: tx('accounts.empty.title'),
											icon: 'drive',
											action: h(
												Button,
												{
													variant: 'light',
													icon: 'plus',
													onClick: function () {
														setTab('add');
													},
												},
												tx('accounts.add'),
											),
										},
										tx('accounts.empty.body'),
									)
								: null,
							accountsList.length ? accountsList.map(renderAccount) : null,
							mcp
								? h(
										'div',
										{ className: 'gdw-account-meta', style: { marginTop: '10px' } },
										tx('mcp.title') +
											': ' +
											(mcp.enabled ? tx('mcp.enabled') : tx('mcp.disabled')) +
											(mcp.path ? ' · ' + tx('mcp.path') + ': ' + mcp.path : '') +
											' · ' +
											(mcp.installed ? tx('mcp.installed') : tx('mcp.notInstalled')),
								)
								: null,
							storage
								? h(
										'div',
										{ className: 'gdw-account-meta' },
										tx('storage.title') +
										': ' +
										(storage === 'files' ? tx('storage.files') : tx('storage.credentials')),
								)
								: null,
						),
					);

					return h(
						'section',
						{ className: 'gdw gdw-settings' },
						h(Styles, { key: 'styles' }),
						h(
							'header',
							{ className: 'gdw-page-header' },
							h(
								'div',
								{ className: 'gdw-heading' },
								h('h1', null, tx('panel.title')),
								h('p', { className: 'gdw-subtitle' }, tx('settings.subtitle')),
							),
							h(
								'div',
								{ className: 'gdw-header-actions' },
								h(
									Button,
									{
										icon: 'plus',
										variant: 'light',
										onClick: function () {
										setTab('add');
									},
								},
								tx('accounts.add'),
							),
								h(
									Button,
									{
										icon: 'refresh',
										onClick: function () {
										loadAccounts();
									},
								},
									tx('common.refresh'),
								),
							),
						),
						h('div', { className: 'gdw-body' }, body),
						dialog && dialog.type === 'add'
							? OnboardingWizard
								? h(OnboardingWizard, {
										key: 'add-wizard',
										onClose: function () {
											setDialog(null);
										},
										onAdded: function () {
											loadAccounts();
										},
									})
								: onboardingError
									? h(AddAccountDialog, {
											key: 'add-legacy',
											onClose: function () {
												setDialog(null);
											},
											onAdded: function () {
												loadAccounts();
											},
									})
								: h(
										Dialog,
										{
											key: 'add-loading',
											title: tx('wizard.title'),
											onClose: function () {
												setDialog(null);
											},
										},
										h('div', { className: 'gdw-loading' }, tx('common.loading')),
									)
							: null,
						dialog && dialog.type === 'edit'
							? h(EditAccountDialog, {
									key: 'edit-' + dialog.account.name,
									account: dialog.account,
									onClose: function () {
										setDialog(null);
									},
									onSaved: function () {
										setDialog(null);
										loadAccounts();
									},
									/* Signing in again renews the account. The dialog stays
									 * open, so that what the user typed and did not save
									 * is still there when they come back to it. */
									onReauthorized: function () {
										loadAccounts();
									},
								})
							: null,
						dialog && dialog.type === 'remove'
							? h(
									Dialog,
									{
										key: 'remove',
										title: tx('accounts.remove.title'),
										onClose: function () {
											setDialog(null);
										},
										busy: removing,
									},
									h(
									'p',
									null,
									isForeign(dialog.account)
										? tx('accounts.remove.body.foreign', { name: dialog.account.name })
										: tx('accounts.remove.body', { name: dialog.account.name }),
								),
									h(
										'div',
										{ className: 'gdw-dialog-footer' },
									h(
											Button,
											{
												variant: 'ghost',
												disabled: removing,
												onClick: function () {
													setDialog(null);
											},
										},
											tx('common.cancel'),
										),
										h(
											Button,
											{
												variant: 'danger',
												icon: 'trash',
												disabled: removing,
											onClick: function () {
												removeAccount(dialog.account);
											},
											},
											tx('accounts.remove.action'),
										),
									),
								)
							: null,
					);
				}

				/* Locale dictionaries live in this file: the browser half cannot
				 * import JSON. The Plugin Manager mirrors them from locale/*.json. */
				ctx.effect(
					function () {
						return ctx.locale.register(LOCALE_NS, {
							en: DICTIONARY.en,
							zh: DICTIONARY.zh,
						});
					},
					'label',
				);

				/* right-sidebar tab: the Drive browser lives in the right
				 * sidebar, next to the workspace files and the terminal, so a
				 * Drive file can be dragged into the conversation. The chunk is
				 * optional: when it cannot be loaded the settings section still
				 * works and only the sidebar tab is missing. */
				var sidebarTab = { enabled: true, dispose: null };

				/**
				 * Mount or unmount the right-sidebar Drive tab.
				 *
				 * The user can turn the tab off in the settings section, so the
				 * registration follows the preference rather than living forever.
				 *
				 * @param {boolean} enabled - whether the tab should be there.
				 */
				function setSidebarTab(enabled) {
					if (sidebarTab.enabled === enabled && sidebarTab.dispose !== null) return;
					if (sidebarTab.dispose) {
						try {
							sidebarTab.dispose();
						} catch (error) {
							// A registration that is already gone needs no cleanup.
						}
						sidebarTab.dispose = null;
					}
					sidebarTab.enabled = enabled;
					if (!enabled) return;
					var state = { alive: true, dispose: null };
					requireFn
						.async('./client.sidebar.js')
						.then(function (module) {
							if (!state.alive || !module || typeof module.register !== 'function') return;
							state.dispose = module.register(ctx, {
								rpc: rpc,
								Icon: Icon,
							});
						})
						.catch(function () {
							// The sidebar tab is an addition, not a requirement: the
							// settings section carries on without it.
						});
					sidebarTab.dispose = function () {
						state.alive = false;
						if (state.dispose) {
							try {
								state.dispose();
							} catch (error) {
								// A registration that is already gone needs no cleanup.
							}
						}
					};
				}

				ctx.effect(
					function () {
						setSidebarTab(true);
						// The preference lives in the plugin's own store, so the
						// tab follows what the user chose in the settings section.
						rpc('settings/get', {})
							.then(function (value) {
								setSidebarTab(!(value && value.sidebarTab === false));
							})
							.catch(function () {
								// Without the preference the tab stays where it is.
							});
						return function () {
							if (sidebarTab.dispose) {
								try {
									sidebarTab.dispose();
								} catch (error) {
									// A registration that is already gone needs no cleanup.
								}
								sidebarTab.dispose = null;
							}
						};
					},
					'google-drive: right sidebar tab',
				);

				/*
				 * The reference source. Its codec is what turns a chip into
				 * model-facing text at submit time, and a chip whose `source`
				 * has no owner here would reject the whole message — so this
				 * registration is what makes a dragged file usable at all.
				 *
				 * The source also answers the `@` menu, so a file can be
				 * picked by typing rather than by dragging it across the
				 * window.
				 */
				ctx.effect(
					function () {
						// `ctx.get` is the dynamic facade's reader for a service
						// this plugin does not declare; an older or narrower
						// context may not carry it at all.
						if (typeof ctx.get !== 'function') return undefined;
						var inputTriggers = ctx.get('inputTriggers');
						if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') {
							return undefined;
						}
						return inputTriggers.registerSource({
							trigger: SOURCE_TRIGGER,
							name: SOURCE_NAME,
							showGroupTitle: false,
							candidates: function (_session, request) {
								return driveCandidates(request);
							},
							onPick: function (request) {
								var value = request && request.candidate ? request.candidate.value : undefined;
								if (!value) return undefined;
								var wire = wireFor(value.account, value.fileId, value.label);
								return {
									insert: {
										source: SOURCE_NAME,
										ref: wire,
										label: value.label,
										appearance: value.folder ? 'folder' : 'file',
										clipboardText: wire,
									},
								};
							},
							codec: {
								clipboardText: function (ref) {
									return String(ref == null ? '' : ref);
								},
								serialize: function (ref) {
									return Promise.resolve(serializeRef(ref));
								},
							},
						});
					},
					'google-drive: reference source',
				);

				/*
				 * The transcript rule. The composer's drop inserts plain text,
				 * so this rule is what renders a dropped wire string as a chip
				 * in the conversation instead of raw text.
				 */
				ctx.effect(
					function () {
						if (typeof ctx.get !== 'function') return undefined;
						var conversation = ctx.get('uiConversation');
						if (
							!conversation ||
							!conversation.userText ||
							typeof conversation.userText.register !== 'function'
						) {
							return undefined;
						}
						return conversation.userText.register({
							id: SOURCE_NAME,
							order: 30,
							match: function (text, from) {
								return matchWire(text, from);
							},
						});
					},
					'google-drive: transcript rule',
				);

				/*
				 * A shortcut that opens the Drive tab in the right sidebar.
				 *
				 * The right sidebar is session-scoped, so the tab can only be
				 * opened for a session that is actually mounted; without one
				 * the shortcut says so instead of failing silently.
				 */
				ctx.effect(
					function () {
						if (typeof ctx.get !== 'function') return undefined;
						var sidebarRight = ctx.get('sidebarRight');
						var shortcuts = ctx.get('shortcuts');
						if (
							!sidebarRight ||
							!shortcuts ||
							typeof shortcuts.register !== 'function' ||
							typeof sidebarRight.openTabFromTarget !== 'function'
						) {
							return undefined;
						}
						return shortcuts.register({
							id: 'google-drive.open',
							label: function () {
								return 'Open Google Drive in the sidebar';
							},
							aliases: ['google drive', 'drive files'],
							defaults: {
								'desktop:macos': { code: 'KeyD', modifiers: ['primary', 'alt'] },
								'desktop:windows': { code: 'KeyD', modifiers: ['primary', 'alt'] },
								'desktop:linux': { code: 'KeyD', modifiers: ['primary', 'alt'] },
								'web:macos': { code: 'KeyD', modifiers: ['primary', 'alt'] },
								'web:windows': { code: 'KeyD', modifiers: ['primary', 'alt'] },
							},
							regions: ['page', 'editable', 'terminal'],
							modals: [],
							resolve: function () {
								var target =
									typeof sidebarRight.commandTarget === 'function'
										? sidebarRight.commandTarget(null)
										: undefined;
								if (target === undefined) {
									return { status: 'blocked', reason: 'No session is open.' };
								}
								return {
									status: 'handled',
									run: function () {
										if (!sidebarRight.isExpanded()) sidebarRight.toggleExpanded();
										sidebarRight.openTabFromTarget('drive', target);
									},
								};
							},
						});
					},
					'google-drive: sidebar shortcut',
				);

				/* The settings section. The accounts live under the harness
				 * Settings; the files live in the right sidebar, next to the
				 * conversation. The plugin owns no left-sidebar icon and no
				 * full-screen page of its own. */
				ctx.slots.inject(SLOT_SETTINGS, function () {
					return ctx.slots.register(
						{
							name: SLOT_SETTINGS,
							id: PANEL_ID,
							order: 25,
							label: function () {
								return tx('panel.title');
							},
							locale: LOCALE_NS,
						},
						GoogleDriveSettings,
					);
				});

				/* The section's nav glyph. */
				ctx.slots.inject(SLOT_SETTINGS_ICON, function () {
					return ctx.slots.register(
						{
							name: SLOT_SETTINGS_ICON,
							id: PANEL_ID,
							locale: LOCALE_NS,
						},
						function DriveIcon(props) {
							var size = props && props.size ? props.size : 16;
							return h(Icon, { name: 'drive', size: size });
						},
					);
				});
			}

			exports.apply = apply;
			exports.inject = inject;
			/* The wire helpers are exported so the browser copy of the
			 * mention grammar can be checked against the host's copy: the
			 * two have to agree rule for rule, or a mention the browser
			 * renders would be one the host leaves in the prompt. */
			exports.wireFor = wireFor;
			exports.matchWire = matchWire;
			exports.serializeRef = serializeRef;
			exports.SOURCE_NAME = SOURCE_NAME;
			return module.exports;
		},
	});
})();
