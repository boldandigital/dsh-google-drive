/**
 * dsh-google-drive — Drive file browser for the right sidebar (browser chunk).
 *
 * The right sidebar is where the harness keeps the panes a session works in:
 * the files tree, the terminal, the browser. Google Drive belongs there too,
 * so a Drive file sits next to a workspace file and behaves the same way —
 * most importantly, it can be dragged into the conversation to tell the agent
 * what to work on.
 *
 * This file is a browser *chunk*, not a bundle: the module loader serves it
 * from the package's `lib/` folder next to `client.js`, and `lib/client.js`
 * pulls it in with `require.async('./client.sidebar.js')`. The file name is
 * forced by the loader — a package-local chunk must match `client.<name>.js`,
 * so `client-sidebar.js` could never be served.
 *
 * Two things make a dropped file useful to the agent, and both are needed:
 *
 *   1. The chip. A reference chip is what the harness turns into a model
 *      reference. It is created by the input-trigger pipeline, and the
 *      pipeline routes a chip to its owner by the chip's `source` when the
 *      message is submitted. A chip whose `source` has no registered owner
 *      with a codec REJECTS THE WHOLE SUBMISSION, so this plugin registers
 *      its own source (`dsh-drive`) with a codec that says which file it is
 *      and which tool reads it.
 *
 *   2. The plain-text fallback. The composer inserts a dropped `text/plain`
 *      as raw text — no chip is created by the drop itself. So the wire
 *      string is also readable by a human in the draft, and this plugin
 *      registers a `conversation.user.text` rule that renders it as a chip
 *      in the transcript.
 *
 * Everything here is plugin-owned: the tab type, the guide capsule, the
 * source, the rule and the rule's dispose all live in effects, so unloading
 * the plugin removes the feature completely and nothing is left behind in
 * the harness.
 */
window.__ModuleLoader__.load({
	id: 'dsh-google-drive',
	chunk: 'client.sidebar.js',
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var React = require('react');
		var h = React.createElement;

		/** The tab type's id. The body and title slots are keyed by it. */
		var TAB_ID = '@boldandigital/dsh-google-drive/drive';

		/** A fresh tab kind. A shipped kind would take over that column. */
		var TAB_KIND = 'drive';

		/**
		 * The reference source's name.
		 *
		 * This is the string a chip carries as its `source`, and the pipeline
		 * looks the chip's owner up by it. The two must be the same string or
		 * the submission is rejected.
		 */
		var SOURCE_NAME = 'dsh-drive';

		/** The trigger that opens the source's menu. */
		var SOURCE_TRIGGER = '@';

		/** Locale namespace owned by this chunk. */
		var LOCALE_NS = 'google-drive-sidebar';

		/** The wire format a dragged or inserted Drive file carries. */
		var WIRE_PREFIX = 'dsh-drive:';

		/**
		 * The English dictionary. Simplified Chinese mirrors it key for key.
		 */
		var en = {
			'type.label': 'Google Drive',
			'tab.title': 'Google Drive',
			'guide.title': 'Google Drive',
			'guide.description': 'Browse and drag files from your Google Drive',
			'accounts.label': 'Account',
			'accounts.empty': 'No Google Drive account yet. Add one in the Google Drive panel.',
			'accounts.change': 'Change account',
			'files.empty': 'This folder is empty.',
			'files.loading': 'Loading…',
			'files.error': 'The files could not be loaded.',
			'files.error.withReason': 'The files could not be loaded: {message}',
			'files.retry': 'Retry',
			'files.root': 'Drive root',
			'files.back': 'Back to the root',
			'files.folder': 'Folder',
			'file.drag': 'Drag into the conversation to give this file to the agent',
			'file.add': 'Add to chat',
			'file.added': 'Added to the chat: {name}',
			'file.addFailed': 'The file could not be added to the chat.',
			'file.sheet': 'Google Sheet',
			'file.doc': 'Google Doc',
			'file.slides': 'Google Slides',
			'file.drawing': 'Google Drawing',
			'file.form': 'Google Form',
			'file.script': 'Google Script',
			'file.shortcut': 'Shortcut',
			'file.folder': 'Folder',
			'file.generic': 'File',
		};

		/** The Simplified Chinese dictionary, key for key with {@link en}. */
		var zh = {
			'type.label': 'Google 云端硬盘',
			'tab.title': 'Google 云端硬盘',
			'guide.title': 'Google 云端硬盘',
			'guide.description': '浏览并拖拽 Google 云端硬盘中的文件',
			'accounts.label': '账号',
			'accounts.empty': '还没有 Google 云端硬盘账号。请在 Google Drive 面板中添加。',
			'accounts.change': '切换账号',
			'files.empty': '此文件夹为空。',
			'files.loading': '加载中…',
			'files.error': '无法加载文件。',
			'files.error.withReason': '无法加载文件：{message}',
			'files.retry': '重试',
			'files.root': '云端硬盘根目录',
			'files.back': '返回根目录',
			'files.folder': '文件夹',
			'file.drag': '拖到对话中，把这个文件交给智能体处理',
			'file.add': '添加到对话',
			'file.added': '已添加到对话：{name}',
			'file.addFailed': '无法把文件添加到对话。',
			'file.sheet': 'Google 表格',
			'file.doc': 'Google 文档',
			'file.slides': 'Google 幻灯片',
			'file.drawing': 'Google 绘图',
			'file.form': 'Google 表单',
			'file.script': 'Google 脚本',
			'file.shortcut': '快捷方式',
			'file.folder': '文件夹',
			'file.generic': '文件',
		};

		/**
		 * The chunk's own styles. Only `--dsw-alias-*` / `--dsw-*` custom
		 * properties are used, each with a literal fallback, and every class
		 * carries the `gdw-` prefix.
		 */
		var STYLES = [
			'.gdw-side{display:grid;gap:10px;min-width:0;padding:12px;',
			'background:var(--dsw-alias-bg-layer-2,#f7f8fa)}',
			'.gdw-side-bar{display:flex;align-items:center;gap:6px;min-width:0}',
			'.gdw-side-select{flex:1;min-width:0;max-width:100%;font:inherit;font-size:12px;padding:4px 6px;',
			'color:var(--dsw-alias-label-primary,#101828);background:var(--dsw-alias-bg-layer-1,#fff);',
			'border:1px solid var(--dsw-alias-border-l3,#e5e8ee);border-radius:var(--dsw-radius-md,6px)}',
			'.gdw-side-back{font:inherit;font-size:12px;padding:3px 7px;cursor:pointer;flex:none;',
			'white-space:nowrap;border-radius:var(--dsw-radius-md,6px);',
			'color:var(--dsw-alias-label-secondary,#667085);background:transparent;border:1px solid transparent}',
			'.gdw-side-back:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f4f7)}',
			'.gdw-side-back:disabled{opacity:.5;cursor:default}',
			'.gdw-side-crumb{font-size:11px;color:var(--dsw-alias-label-secondary,#667085);overflow:hidden;',
			'text-overflow:ellipsis;white-space:nowrap;min-width:0}',
			'.gdw-side-list{display:grid;gap:2px;min-width:0}',
			'.gdw-side-row{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:8px;',
			'min-width:0;padding:5px 6px;border-radius:var(--dsw-radius-md,6px);cursor:grab}',
			'.gdw-side-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f7)}',
			'.gdw-side-row:active{cursor:grabbing}',
			'.gdw-side-row-icon{display:flex;align-items:center;justify-content:center;',
			'color:var(--dsw-alias-label-secondary,#667085);flex:none}',
			'.gdw-side-row-main{display:flex;flex-direction:column;gap:1px;min-width:0}',
			'.gdw-side-row-name{font-size:12.5px;color:var(--dsw-alias-label-primary,#101828);',
			'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gdw-side-row-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#667085);',
			'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gdw-side-row-action{font:inherit;font-size:11px;padding:2px 6px;cursor:pointer;flex:none;',
			'white-space:nowrap;',
			'color:var(--dsw-alias-label-secondary,#667085);background:transparent;',
			'border:1px solid var(--dsw-alias-border-l3,#e5e8ee);border-radius:var(--dsw-radius-md,6px)}',
			'.gdw-side-row-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.gdw-side-row-action:disabled{opacity:.5;cursor:default}',
			'.gdw-side-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#667085);padding:10px 6px}',
			'.gdw-side-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d20);padding:6px}',
		];

		/* ------------------------------------------------------------------ *
		 * The wire format                                                     *
		 * ------------------------------------------------------------------ */

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
			return '@[' + escapeLabel(label) + '](' + WIRE_PREFIX + encodeURIComponent(String(account || '')) + '/' + encodeURIComponent(String(fileId || '')) + ')';
		}

		/**
		 * The rule that recognises a wire string in the transcript.
		 *
		 * The label may contain anything, so it is matched lazily rather than
		 * by a character class that a name could break.
		 *
		 * The node it returns is a plain-text node with a display, not a
		 * business node: the harness owns the business node kinds, and
		 * claiming one would replace a shipped renderer.
		 *
		 * @param {string} text - the text to search.
		 * @param {number} from - where to start searching.
		 * @returns {object|null} the match, or null.
		 */
		function matchWire(text, from) {
			if (typeof text !== 'string') return null;
			var start = from > 0 ? from : 0;
			var at = text.indexOf('@[', start);
			while (at !== -1) {
				// `close` is the index of the `]` that ends the label; the
				// body starts after the `](` that follows it.
				var close = text.indexOf('](' + WIRE_PREFIX, at + 2);
				if (close !== -1) {
					var bodyStart = close + ']('.length + WIRE_PREFIX.length;
					var end = text.indexOf(')', bodyStart);
					if (end !== -1) {
						var label = unescapeLabel(text.slice(at + 2, close));
						var body = text.slice(bodyStart, end);
						var slash = body.indexOf('/');
						if (slash !== -1) {
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
		 * The Google-native kinds, by mime type.
		 *
		 * Drive gives a native document no file extension, so the mime type
		 * is the only thing that says whether a row is a document, a sheet
		 * or a slide deck.
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
		 * Whether one row is a folder.
		 *
		 * Drive marks a folder with its own mime type and gives it no file
		 * extension, so the mime type is the only thing that says which it is.
		 *
		 * @param {object} file - the Drive file.
		 * @returns {boolean} whether the row is a folder.
		 */
		function isFolder(file) {
			return !!(file && file.mimeType === 'application/vnd.google-apps.folder');
		}

		/**
		 * The badge one file row carries.
		 *
		 * A Google-native file has no extension in its name, so it is named
		 * by its kind; an ordinary file is named by the ending of its own
		 * name, which is what the user recognises it by.
		 *
		 * @param {object} file - the Drive file.
		 * @param {function} t - the chunk's translation function.
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
			if (slash !== -1 && mimeType.length > slash + 1) return mimeType.slice(slash + 1).toUpperCase();
			return t('file.generic');
		}

		/**
		 * The model-facing text of one Drive reference.
		 *
		 * The mention itself is the model form: the host rewrites it into a
		 * readable label and a block that names the account and the file id.
		 *
		 * @param {string} ref - the encoded `account/fileId` pair.
		 * @returns {string} the model-facing text.
		 */
		function serializeRef(ref) {
			return String(ref == null ? '' : ref);
		}

		/* ------------------------------------------------------------------ *
		 * The tab body                                                        *
		 * ------------------------------------------------------------------ */

		/**
		 * Build the right-sidebar tab body.
		 *
		 * @param {object} deps - the pieces shared with the main bundle.
		 * @returns {function} the React component.
		 */
		function createDriveTab(deps) {
			var options = deps || {};
			var rpc = options.rpc;
			var Icon = options.Icon;
			var t = options.t;
			/* The plugin context: the chip insertion reads the harness's
			 * session services through it. */
			var ctx = options.ctx;

			/**
			 * One file row.
			 *
			 * The row is draggable: the composer inserts a dropped
			 * `text/plain` as raw text, so the wire string travels that way
			 * and the transcript renders it as a chip. The button next to it
			 * is the keyboard-reachable equivalent.
			 *
			 * @param {object} file - the Drive file.
			 * @param {string} account - the account it belongs to.
			 * @param {function} onOpen - called when the row is opened.
			 * @param {function} onAdd - called when the row is added to the chat.
			 * @returns {object} the React element.
			 */
			function FileRow(props) {
				var file = props.file;
				var account = props.account;
				var folder = isFolder(file);
				var label = file.name || '';
				var wire = wireFor(account, file.id, label);
				var kindLabel = fileKindLabel(file, t);
				return h(
					'div',
					{
						className: 'gdw-side-row',
						draggable: true,
						title: t('file.drag'),
						'data-drive-file': file.id,
						onDragStart: function (event) {
							try {
								event.dataTransfer.effectAllowed = 'copy';
								event.dataTransfer.setData('text/plain', wire);
							} catch (error) {
								// A browser that refuses the transfer still lets
								// the button below do the work.
							}
						},
					},
					h(
						'span',
						{ className: 'gdw-side-row-icon' },
						Icon ? h(Icon, { name: folder ? 'folder' : 'file', size: 15 }) : null,
					),
					h(
						'button',
						{
							type: 'button',
							className: 'gdw-side-row-main',
							onClick: function () {
								/* A folder opens; a file is what the user wants in the
								 * conversation, so it is handed over. */
								if (folder) props.onOpen(file);
								else props.onAdd(file);
							},
							style: {
								background: 'transparent',
								border: 'none',
								padding: '0',
								textAlign: 'left',
								font: 'inherit',
								cursor: 'pointer',
							},
						},
						h('span', { className: 'gdw-side-row-name' }, label),
						h('span', { className: 'gdw-side-row-meta' }, kindLabel),
					),
					h(
						'button',
						{
							type: 'button',
							className: 'gdw-side-row-action',
							onClick: function (event) {
								event.stopPropagation();
								props.onAdd(file);
							},
						},
						t('file.add'),
					),
				);
			}

			/**
			 * The tab body itself.
			 *
			 * @returns {object} the React element.
			 */
			function DriveTab(props) {
				var tabProps = props || {};
				var state = React.useState([]);
				var accounts = state[0];
				var setAccounts = state[1];
				var accountState = React.useState('');
				var account = accountState[0];
				var setAccount = accountState[1];
				var filesState = React.useState(null);
				var files = filesState[0];
				var setFiles = filesState[1];
				var errorState = React.useState('');
				var error = errorState[0];
				var setError = errorState[1];
				var folderState = React.useState('root');
				var folder = folderState[0];
				var setFolder = folderState[1];
				var crumbState = React.useState([]);
				var crumbs = crumbState[0];
				var setCrumbs = crumbState[1];
				var addedState = React.useState('');
				var added = addedState[0];
				var setAdded = addedState[1];

				React.useEffect(
					function () {
						var alive = true;
						rpc('accounts/list', {})
							.then(function (value) {
								if (!alive) return;
								var list = (value && value.accounts) || [];
								setAccounts(list);
								setAccount(function (current) {
									if (current && list.some(function (item) { return item.name === current; })) return current;
									return list.length ? list[0].name : '';
								});
							})
							.catch(function () {
								if (alive) setError(t('files.error'));
							});
						return function () {
							alive = false;
						};
					},
					[],
				);

				React.useEffect(
					function () {
						if (!account) {
							setFiles(null);
							return;
						}
						var alive = true;
						rpc('drive/list', { account: account, folderId: folder })
							.then(function (value) {
								if (!alive) return;
								setFiles((value && value.files) || []);
								setError('');
							})
							.catch(function (error) {
								if (alive) {
									setFiles([]);
									/* The host knows why: a refused token, a missing
									 * share, a wrong folder. Say that instead of a
									 * shrug. */
									setError(
										error && error.message
											? t('files.error.withReason', { message: error.message })
											: t('files.error'),
									);
								}
							});
						return function () {
							alive = false;
						};
					},
					[account, folder],
				);

				function openFolder(file) {
					setCrumbs(function (current) {
						return current.concat([{ id: file.id, name: file.name }]);
					});
					setFolder(file.id);
				}

				function goToRoot() {
					setCrumbs([]);
					setFolder('root');
				}

				function goUp() {
					setCrumbs(function (current) {
						if (!current.length) return current;
						var next = current.slice(0, current.length - 1);
						setFolder(next.length ? next[next.length - 1].id : 'root');
						return next;
					});
				}

				/**
				 * Insert one Drive file into the composer as a real chip.
				 *
				 * The chip is the harness's own reference chip: the mention is
				 * what the composer keeps, and the host rewrites it into a
				 * reference the agent can act on. Inserting it needs the
				 * session-scoped input actions and the trigger controller that
				 * owns the chip's serializer.
				 *
				 * @param {object} file - the Drive file.
				 * @returns {boolean} whether the chip was inserted.
				 */
				function insertChip(file) {
					var actions = tabProps.inputActions;
					var sessionId = tabProps.sessionId;
					if (!actions || typeof actions.captureInsertion !== 'function') return false;
					if (!sessionId) return false;
					if (typeof ctx.get !== 'function') return false;
					var triggers = ctx.get('inputTriggers');
					var sessions = ctx.get('sessions');
					if (!triggers || typeof triggers.sessionOf !== 'function') return false;
					if (!sessions || typeof sessions.binding !== 'function') return false;
					var binding = sessions.binding(sessionId);
					if (!binding || !binding.ctx) return false;
					var controller = triggers.sessionOf(binding.ctx);
					if (!controller || typeof controller.execute !== 'function') return false;
					var wire = wireFor(account, file.id, file.name || '');
					return (
						controller.execute(
							{
								insert: {
									source: SOURCE_NAME,
									ref: wire,
									label: file.name || '',
									appearance: 'file',
									clipboardText: wire,
								},
							},
							actions.captureInsertion(),
						) === true
					);
				}

				/**
				 * Insert the mention as plain text.
				 *
				 * The fallback for a harness that offers no chip path: the text
				 * still reaches the host, which resolves it the same way.
				 *
				 * @param {string} wire - the mention.
				 * @returns {boolean} whether the text was inserted.
				 */
				function insertText(wire) {
					var actions = tabProps.inputActions;
					if (!actions || typeof actions.insertText !== 'function') return false;
					if (typeof actions.captureInsertion !== 'function') return false;
					return actions.insertText(wire, actions.captureInsertion()) === true;
				}

				function addToChat(file) {
					var wire = wireFor(account, file.id, file.name || '');
					var done = false;
					var failure = '';
					try {
						done = insertChip(file);
					} catch (error) {
						failure = describe(error);
					}
					if (!done && failure === '') {
						try {
							done = insertText(wire);
						} catch (error) {
							failure = describe(error);
						}
					}
					if (done) {
						setAdded(t('file.added', { name: file.name }));
						return;
					}
					setAdded(failure === '' ? t('file.addFailed') : t('file.addFailed') + ' (' + failure + ')');
				}

				/**
				 * One line about a failure, for the sidebar.
				 *
				 * @param {unknown} error - the thrown value.
				 * @returns {string} the message.
				 */
				function describe(error) {
					if (!error) return '';
					var message = error && error.message ? error.message : String(error);
					return String(message).slice(0, 160);
				}

				if (!accounts.length) {
					return h(
						'div',
						{ className: 'gdw-side' },
						h('style', null, STYLES),
						h('div', { className: 'gdw-side-empty' }, t('accounts.empty')),
					);
				}

				return h(
					'div',
					{ className: 'gdw-side' },
					h('style', null, STYLES),
					h(
						'div',
						{ className: 'gdw-side-bar' },
						h(
							'select',
							{
								className: 'gdw-side-select',
								value: account,
								'aria-label': t('accounts.label'),
								onChange: function (event) {
									goToRoot();
									setAccount(event.target.value);
								},
							},
							accounts.map(function (item) {
								return h('option', { key: item.name, value: item.name }, item.name);
							}),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'gdw-side-back',
								onClick: goUp,
								disabled: !crumbs.length,
							},
							t('files.back'),
						),
					),
					h('div', { className: 'gdw-side-crumb' }, crumbs.length ? crumbs[crumbs.length - 1].name : t('files.root')),
					error ? h('div', { className: 'gdw-side-error' }, error) : null,
					added ? h('div', { className: 'gdw-side-empty' }, added) : null,
					files === null
						? h('div', { className: 'gdw-side-empty' }, t('files.loading'))
						: files.length
							? h(
									'div',
									{ className: 'gdw-side-list' },
									files.map(function (file) {
										return h(FileRow, {
											key: file.id,
											file: file,
											account: account,
											onOpen: openFolder,
											onAdd: addToChat,
										});
									}),
								)
							: h('div', { className: 'gdw-side-empty' }, t('files.empty')),
				);
			}

			return DriveTab;
		}

		/* ------------------------------------------------------------------ *
		 * Registration                                                        *
		 * ------------------------------------------------------------------ */

		/**
		 * Register the tab type, the body, the title, the guide capsule, the
		 * reference source and the transcript rule.
		 *
		 * Every registration lives in an effect, so unloading the plugin
		 * removes all of it and the harness is left as it was.
		 *
		 * @param {object} ctx - the plugin context.
		 * @param {object} deps - the pieces shared with the main bundle.
		 * @returns {function} a disposer for everything registered.
		 */
		function register(ctx, deps) {
			var options = deps || {};
			var disposers = [];

			/* This chunk owns its own locale namespace, so its strings
			 * translate with the rest of the plugin and disappear with it. */
			disposers.push(ctx.locale.register(LOCALE_NS, { en: en, zh: zh }));
			var t = ctx.locale.bind(LOCALE_NS);

			/**
			 * The tab body's title.
			 *
			 * @returns {object} the React element.
			 */
			function Title() {
				return h('span', null, t('tab.title'));
			}

			/* The guide capsule on the right sidebar's Start screen. */
			var tabs = ctx.get('sidebarRightTabs');
			if (tabs && typeof tabs.register === 'function') {
				disposers.push(
					tabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						multiple: true,
						title: function () {
							return t('type.label');
						},
						guide: [
							{
								id: 'drive',
								order: 30,
								title: function () {
									return t('guide.title');
								},
								description: function () {
									return t('guide.description');
								},
								icon: DriveGlyph,
							},
						],
					}),
				);
			}

			/* The tab body and its chip title. */
			disposers.push(
				ctx.slots.inject('sidebar.right.pane.tab', function () {
					return ctx.slots.register(
						{
							name: 'sidebar.right.pane.tab',
							key: TAB_ID,
							locale: LOCALE_NS,
						},
						createDriveTab({
							rpc: options.rpc,
							Icon: options.Icon,
							t: t,
							ctx: ctx,
						}),
					);
				}),
			);
			disposers.push(
				ctx.slots.inject('sidebar.right.pane.tab.title', function () {
					return ctx.slots.register(
						{
							name: 'sidebar.right.pane.tab.title',
							key: TAB_ID,
							locale: LOCALE_NS,
						},
						Title,
					);
				}),
			);

			/*
			 * The reference source and the transcript rule are registered by
			 * the main bundle: both are keyed by a name the harness keeps
			 * globally, so registering them twice would throw. The main
			 * bundle owns them because the panel works even when this chunk
			 * cannot be loaded.
			 */

			return function () {
				for (var index = disposers.length - 1; index >= 0; index -= 1) {
					try {
						disposers[index]();
					} catch (error) {
						// A registration that is already gone needs no cleanup.
					}
				}
			};
		}

		/**
		 * The guide capsule's glyph.
		 *
		 * A small inline drawing, because a browser chunk cannot import the
		 * harness's artwork package.
		 *
		 * @param {object} props - the size and class the guide passes.
		 * @returns {object} the React element.
		 */
		function DriveGlyph(props) {
			var options = props || {};
			var size = options.size ? options.size : 22;
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					'aria-hidden': 'true',
					className: options.className,
				},
				h('path', {
					d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h3.2c.6 0 1.2.24 1.6.66l1.1 1.14c.4.42 1 .66 1.6.66h3.5A2.5 2.5 0 0 1 20 8.96V17.5A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z',
					stroke: 'currentColor',
					strokeWidth: '1.6',
					strokeLinejoin: 'round',
				}),
			);
		}

		exports.createDriveTab = createDriveTab;
		exports.register = register;
		exports.wireFor = wireFor;
		exports.matchWire = matchWire;
		exports.serializeRef = serializeRef;
		exports.SOURCE_NAME = SOURCE_NAME;
		exports.TAB_ID = TAB_ID;
		exports.dictionaries = { en: en, zh: zh };
		return module.exports;
	},
});
