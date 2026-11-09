/**
 * dsh-google-drive — guided onboarding wizard (browser chunk).
 *
 * The wizard replaces the raw "Add account" dialog with three steps: choose
 * how to connect, set the access up, and confirm. It offers the one-click
 * routes the host can supply — the OAuth clients and the service accounts
 * this Mac already has — and keeps the manual route available whenever
 * detection is unavailable. A first-time user never has to know what a
 * client id is.
 *
 * This file is a browser *chunk*, not a bundle: the module loader serves it
 * from the package's `lib/` folder next to `client.js`, and `lib/client.js`
 * pulls it in with `require.async('./client.onboarding.js')`. The file name
 * is forced by the loader — a package-local chunk must match
 * `client.<name>.js`, so `client-onboarding.js` could never be served.
 *
 * Everything the wizard shares with the main bundle — the translator, the
 * RPC helper, the shared UI components and the legacy add-account dialog —
 * is handed in by `lib/client.js` as `deps`.
 */
window.__ModuleLoader__.load({
	id: 'dsh-google-drive',
	chunk: 'client.onboarding.js',
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var React = require('react');
		var h = React.createElement;

		/**
		 * How long one detection scan may take before the wizard moves on.
		 *
		 * The host probes gcloud, and gcloud takes 15-30s on a cold cache: the
		 * CLI resolves its own auth and API enablement first. A shorter budget
		 * would report "scan failed" on a machine that answers perfectly, so
		 * this waits for the real thing and only gives up on a genuine hang.
		 */
		var DETECT_TIMEOUT_MS = 45000;

		/** Where the OAuth client id and secret are created. */
		var CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials';

		/**
		 * The wizard's own styles. Only `--dsw-alias-*` / `--dsw-*` custom
		 * properties are used, each with a literal fallback, and every class
		 * carries the `gdw-` prefix.
		 */
		var WIZARD_STYLES = [
			'.gdw-wizard{display:grid;gap:16px;min-width:0}',
			'.gdw-wizard-lead{font-size:13px;color:var(--dsw-alias-label-secondary,#667085);line-height:1.6}',
			'.gdw-wizard .gdw-tabs>button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:start}',
			'.gdw-wizard .gdw-tabs>button .gdw-tab-title{font-size:14px;font-weight:600}',
			'.gdw-wizard .gdw-tabs>button .gdw-tab-sub{font-size:12px;font-weight:400;',
			'color:var(--dsw-alias-label-secondary,#667085);max-width:32ch}',
			'.gdw-wizard-section{display:grid;gap:10px;min-width:0}',
			'.gdw-wizard-section>h3{font-size:14px;font-weight:600}',
			'.gdw-wizard-dot{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;',
			'border:1px solid var(--dsw-alias-border-l3,#e5e8ee);font-size:11px;flex-shrink:0;background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.gdw-wizard-client{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;min-width:0;',
			'border:1px solid var(--dsw-alias-border-l3,#e5e8ee);border-radius:8px;padding:10px 12px;',
			'background:var(--dsw-alias-bg-layer-2,#f6f7f9)}',
			'.gdw-wizard-client-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}',
			'.gdw-wizard-client-name{font-size:14px;font-weight:600;overflow-wrap:anywhere}',
			'.gdw-wizard-client-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
			'color:var(--dsw-alias-label-secondary,#667085);overflow-wrap:anywhere}',
			'.gdw-wizard-client-path{font-size:11px;color:var(--dsw-alias-label-secondary,#667085);opacity:.85;overflow-wrap:anywhere}',
			'.gdw-wizard-done{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:12px 0}',
			'.gdw-wizard-done>svg{color:var(--dsw-alias-state-success-primary,#1f7a48)}',
			'.gdw-wizard-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}',
			'.gdw-wizard-list{display:grid;gap:6px;margin:0;padding-left:20px;font-size:13px;line-height:1.6;',
			'color:var(--dsw-alias-label-primary,#1b2430);min-width:0}',
			'.gdw-wizard-list>li{min-width:0;overflow-wrap:anywhere}',
			'.gdw-wizard-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-warn-primary,#8a5a00);overflow-wrap:anywhere}',
		].join('');

		/**
		 * Whether a detected OAuth client can be used by this plugin.
		 *
		 * The plugin signs in through a loopback redirect
		 * (`http://localhost:<port>/oauth/google/callback`), and Google only
		 * accepts a loopback redirect for a Desktop app client. A web client
		 * has a fixed redirect-URI list, so Google answers
		 * `redirect_uri_mismatch` for it — offering one as a one-click choice
		 * is a trap.
		 *
		 * @param {object} client - one detected client.
		 * @returns {boolean} true when the client is a Desktop app client.
		 */
		function isOneClickClient(client) {
			return !!client && client.type === 'installed';
		}

		/**
		 * Read the client id and the client secret out of a downloaded OAuth
		 * client file. Google writes the secret into the section that matches
		 * the application type, so both file shapes are read.
		 *
		 * @param {object} data - the parsed JSON file.
		 * @returns {{clientId: string, clientSecret: string, type: string}} the values.
		 */
		function readClientFile(data) {
			var source = data && typeof data === 'object' ? data : {};
			var installed = source.installed && typeof source.installed === 'object' ? source.installed : null;
			var web = source.web && typeof source.web === 'object' ? source.web : null;
			var section = installed || web;
			function pick(value) {
				return typeof value === 'string' ? value.trim() : '';
			}
			return {
				clientId: pick(source.client_id) || pick(section && section.client_id),
				clientSecret: pick(source.client_secret) || pick(section && section.client_secret),
				type: installed ? 'installed' : web ? 'web' : '',
			};
		}

		/**
		 * Turn a free-form name into something the host accepts as an account
		 * name: letters, digits, underscore and dash only.
		 *
		 * @param {string} value - the candidate name.
		 * @returns {string} the sanitized name.
		 */
		function sanitizeName(value) {
			return String(value || '')
				.replace(/[^a-zA-Z0-9_-]+/g, '-')
				.replace(/^-+/, '')
				.replace(/-+$/, '')
				.slice(0, 40);
		}

		/**
		 * Build the wizard component.
		 *
		 * @param {object} deps - the pieces the main bundle shares.
		 * @returns {function} the wizard component.
		 */
		function createOnboardingWizard(deps) {
			var tx = deps.tx;
			var rpc = deps.rpc;
			var Button = deps.Button;
			var Field = deps.Field;
			var Status = deps.Status;
			var Dialog = deps.Dialog;
			var Icon = deps.Icon;
			var AddAccountDialog = deps.AddAccountDialog;

			/**
			 * The guided add-account wizard.
			 *
			 * @param {object} props - the component props.
			 * @returns {object} the rendered wizard.
			 */
			function OnboardingWizard(props) {
				var onClose = props.onClose;
				var onAdded = props.onAdded;

				/* The method the user is looking at: 'oauth' or 'service'. */
				var [tab, setTab] = React.useState('oauth');
				/* detect: { state: 'idle' | 'loading' | 'ready' | 'error', data } */
				var [detect, setDetect] = React.useState({ state: 'idle', data: null });
				var [detectError, setDetectError] = React.useState('');
				var [selectedClientId, setSelectedClientId] = React.useState('');
				/* The client the user picked from a downloaded JSON file. */
				var [pickedClientId, setPickedClientId] = React.useState('');
				var [pickedClientSecret, setPickedClientSecret] = React.useState('');
				var [pickedFileName, setPickedFileName] = React.useState('');
				var [fileError, setFileError] = React.useState('');
				var [fileWarning, setFileWarning] = React.useState('');
				var fileFieldId = React.useId();
				/* The client id the form is filled with: the picked file wins. */
				var effectiveClientId = pickedClientId || selectedClientId;
				var [projectId, setProjectId] = React.useState('');
				var [serviceEmail, setServiceEmail] = React.useState('');
				var [gcloudName, setGcloudName] = React.useState('');
				var [gcloudSubject, setGcloudSubject] = React.useState('');
				var [busy, setBusy] = React.useState(false);
				var [error, setError] = React.useState('');

				/**
				 * The gcloud part of the last detection answer.
				 *
				 * @returns {object|null} the gcloud state.
				 */
				function gcloud() {
					return (detect.data && detect.data.gcloud) || null;
				}

				/** True when gcloud is installed and signed in. */
				function gcloudReady() {
					var state = gcloud();
					return !!(state && state.available && state.authenticated);
				}

				/** Why the gcloud route is not available. */
				function gcloudMissingReason() {
					var state = gcloud();
					return state && state.available
						? tx('wizard.detect.gcloudSignedOut')
						: tx('wizard.detect.gcloudMissing');
				}

				/**
				 * The name the account is stored under when the user does not
				 * change it.
				 *
				 * The name is the one thing the form cannot fill in by itself,
				 * and a name nobody has to think about is what makes the path
				 * one click long.
				 */
				var defaultAccountName = 'google';

				/** The OAuth clients found on this machine. */
				function oauthClients() {
					return (detect.data && detect.data.oauthClients) || [];
				}

				/** The projects gcloud can reach. */
				function projectList() {
					var state = gcloud();
					return (state && state.projects) || [];
				}

				/** The service accounts gcloud knows about. */
				function accountList() {
					var data = detect.data || {};
					var state = gcloud();
					if (state && Array.isArray(state.serviceAccounts)) return state.serviceAccounts;
					return Array.isArray(data.serviceAccounts) ? data.serviceAccounts : [];
				}

				/** The project the picker shows. */
				function currentProject() {
					var projects = projectList();
					if (projectId && projects.some(function (project) { return project.id === projectId; })) {
						return projectId;
					}
					return projects.length ? projects[0].id : '';
				}

				/** The service accounts of one project. */
				function accountsFor(project) {
					return accountList().filter(function (account) {
						return !account.projectId || account.projectId === project;
					});
				}

				/** The service account the picker shows. */
				function currentAccount() {
					var accounts = accountsFor(currentProject());
					if (serviceEmail && accounts.some(function (account) { return account.email === serviceEmail; })) {
						return serviceEmail;
					}
					return accounts.length ? accounts[0].email : '';
				}

				/** The name the gcloud route stores the account under. */
				function currentName() {
					if (gcloudName.trim()) return gcloudName.trim();
					var account = currentAccount();
					return account ? sanitizeName(account.split('@')[0]) : '';
				}

				/**
				 * Scan this machine for OAuth clients and gcloud.
				 *
				 * A missing endpoint, a failed probe or a slow probe never
				 * blocks the wizard: the manual route stays available.
				 */
				function scan() {
					setDetect(function (current) {
						return { state: 'loading', data: current.data };
					});
					setDetectError('');
					var settled = false;
					var timer = setTimeout(function () {
						if (settled) return;
						settled = true;
						setDetect(function (current) {
							return { state: 'error', data: current.data };
						});
						setDetectError(tx('wizard.detect.timeout'));
					}, DETECT_TIMEOUT_MS);
					rpc('onboarding/detect', {})
						.then(function (value) {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							setDetect({ state: 'ready', data: value || {} });
							// One usable client on this machine is the one the user
							// wants: pick it, so the sign-in is one click long.
							var found = (value && value.oauthClients) || [];
							var usable = found.filter(isOneClickClient);
							if (usable.length === 1) setSelectedClientId(usable[0].clientId || '');
						})
						.catch(function (scanError) {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							setDetect(function (current) {
								return { state: 'error', data: current.data };
							});
							var code = scanError && scanError.code;
							setDetectError(
								code === 'unknown-endpoint'
									? tx('wizard.detect.unavailable')
									: tx('wizard.detect.failed', {
										message: scanError && scanError.message ? scanError.message : '',
									}),
							);
						});
				}

				React.useEffect(function () {
					scan();
					return undefined;
				}, []);

				/**
				 * Read the downloaded OAuth client file in the browser and fill
				 * the client id and secret into the form. Nothing leaves the
				 * machine: the file is read here and never sent anywhere.
				 *
				 * @param {object} event - the file input's change event.
				 */
				function onFileChosen(event) {
					var file = event && event.target && event.target.files ? event.target.files[0] : null;
					if (!file) return;
					setFileError('');
					setFileWarning('');
					var reader = new FileReader();
					reader.onload = function () {
						var parsed = null;
						try {
							parsed = JSON.parse(String(reader.result));
						} catch (error) {
							setFileError(
								tx('wizard.desktop.failed', {
									message: error && error.message ? error.message : '',
								}),
							);
							return;
						}
						var client = readClientFile(parsed);
						if (!client.clientId || !client.clientSecret) {
							setFileError(tx('wizard.desktop.noClient'));
							return;
						}
						setPickedClientId(client.clientId);
						setPickedClientSecret(client.clientSecret);
						setPickedFileName(file.name || '');
						setSelectedClientId(client.clientId);
						if (client.type === 'web') {
							setFileWarning(tx('wizard.desktop.webOnly'));
						}
					};
					reader.onerror = function () {
						setFileError(tx('wizard.desktop.failed', { message: '' }));
					};
					reader.readAsText(file);
				}

				/**
				 * Show another method.
				 *
				 * @param {string} value - the method to show.
				 */
				function choose(value) {
					setTab(value);
					setError('');
				}

				/**
				 * Move the focus inside the method chooser. The arrows only
				 * move the focus; Enter and Space pick the method.
				 *
				 * @param {object} event - the key event.
				 */
				function onChoiceKeyDown(event) {
					var keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
					if (keys.indexOf(event.key) === -1) return;
					var buttons = Array.prototype.slice.call(
						event.currentTarget.querySelectorAll('button[role="tab"]'),
					);
					if (!buttons.length) return;
					var index = buttons.indexOf(document.activeElement);
					if (index === -1) index = 0;
					event.preventDefault();
					var next = index;
					if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
						next = (index + 1) % buttons.length;
					} else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
						next = (index - 1 + buttons.length) % buttons.length;
					} else if (event.key === 'Home') {
						next = 0;
					} else if (event.key === 'End') {
						next = buttons.length - 1;
					}
					buttons[next].focus();
				}

				/**
				 * Mint a service-account key with gcloud and store it. The
				 * user never handles the JSON file.
				 */
				function createKey() {
					if (busy) return;
					var project = currentProject();
					var account = currentAccount();
					var name = currentName();
					if (!project || !account || !name) {
						setError(tx('wizard.service.gcloud.failed', { message: tx('wizard.service.gcloud.noAccounts') }));
						return;
					}
					setError('');
					setBusy(true);
					rpc('onboarding/create-service-key', {
						projectId: project,
						serviceAccountEmail: account,
					})
						.then(function (value) {
							var key = value && value.key;
							if (!key) throw new Error(tx('wizard.service.gcloud.failed', { message: '' }));
							return rpc('accounts/add-service', {
								name: name,
								keyJson: JSON.stringify(key),
								subject: gcloudSubject.trim() ? gcloudSubject.trim() : undefined,
							});
						})
						.then(function (value) {
							var account = (value && value.account) || null;
							if (onAdded) onAdded(account);
							onClose();
						})
						.catch(function (createError) {
							setError(
								tx('wizard.service.gcloud.failed', {
									message: createError && createError.message ? createError.message : '',
								}),
							);
						})
						.finally(function () {
							setBusy(false);
						});
				}

				/**
				 * The methods, as tabs.
				 *
				 * One click on the tab, one button to confirm: there is no step
				 * to walk through in between.
				 *
				 * @returns {object} the rendered tab bar.
				 */
				function tabBar() {
					var tabs = [
						{ id: 'oauth', label: tx('wizard.option.oauth.title'), hint: tx('wizard.option.oauth.sub') },
						{ id: 'service', label: tx('wizard.option.service.title'), hint: tx('wizard.option.service.sub') },
					];
					return h(
						'div',
						{
							className: 'gdw-tabs',
							role: 'tablist',
							'aria-label': tx('wizard.choose.group'),
							onKeyDown: onChoiceKeyDown,
						},
						tabs.map(function (entry) {
							return h(
								'button',
								{
									type: 'button',
									role: 'tab',
									key: entry.id,
									'aria-selected': tab === entry.id ? 'true' : 'false',
									className: 'gdw-tab' + (tab === entry.id ? ' gdw-tab-on' : ''),
									onClick: function () {
										choose(entry.id);
									},
								},
								h('span', { className: 'gdw-tab-title' }, entry.label),
								h('span', { className: 'gdw-tab-sub' }, entry.hint),
							);
						}),
					);
				}

				/** What the machine already has, and a way to scan again. */
				function detectPanel() {
					var state = gcloud();
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
						detect.state === 'loading'
							? h('div', { className: 'gdw-loading' }, tx('wizard.detect.scanning'))
							: null,
						detect.state === 'error' && detectError
							? h(Status, { tone: 'warn' }, detectError)
							: null,
						detect.state === 'ready' && state
							? state.available && state.authenticated
								? h(
										'div',
										{ className: 'gdw-field-hint' },
										tx('wizard.detect.gcloudAccount', { account: state.account || '' }),
									)
								: h('div', { className: 'gdw-field-hint' }, gcloudMissingReason())
							: null,
						h(
							'div',
							{ className: 'gdw-toolbar' },
							h(
								Button,
								{
									icon: 'refresh',
									disabled: detect.state === 'loading',
									onClick: scan,
								},
								detect.state === 'ready' ? tx('wizard.detect.rescan') : tx('wizard.detect.scan'),
							),
						),
					);
				}

				/** The Google-account tab. */
				function oauthTab() {
					return h(
						'div',
						{ className: 'gdw-wizard' },
						detectedClients(),
						desktopPanel(),
						h(
							'div',
							{ className: 'gdw-wizard-section' },
							h('h3', null, tx('wizard.oauth.manual.title')),
							h('p', { className: 'gdw-wizard-lead' }, tx('wizard.oauth.manual.hint')),
							h(
								'div',
								{ className: 'gdw-wizard-inline' },
								h(
									'a',
									{ href: CREDENTIALS_URL, target: '_blank', rel: 'noreferrer noopener' },
									tx('wizard.oauth.instructions'),
								),
							),
							h('div', { className: 'gdw-field-hint' }, tx('wizard.oauth.secretHint')),
							h(AddAccountDialog, {
								key: 'oauth',
								embedded: true,
								mode: 'oauth',
								initialClientId: effectiveClientId,
								initialClientSecret: pickedClientSecret,
								initialName: defaultAccountName,
								onClose: function () {
									onClose();
								},
								onAdded: function (account) {
									if (onAdded) onAdded(account);
								},
							}),
						),
					);
				}

				/**
				 * The OAuth clients this machine already has.
				 *
				 * Only a Desktop app client can sign this plugin in: the OAuth
				 * flow redirects to `http://localhost:<port>`, and Google
				 * rejects a loopback redirect for a web client. A web client
				 * is therefore listed as what it is — not usable here — with
				 * the way out spelled out, instead of being offered as a
				 * one-click choice that fails at the consent screen.
				 */
				function detectedClients() {
					var clients = oauthClients();
					var usable = clients.filter(isOneClickClient);
					var unusable = clients.filter(function (client) {
						return !isOneClickClient(client);
					});
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
						h('h3', null, tx('wizard.detect.oauthClients')),
						h('p', { className: 'gdw-wizard-lead' }, tx('wizard.oauth.found.body')),
						usable.length
							? usable.map(function (client) {
									var picked = effectiveClientId === client.clientId;
									return h(
										'div',
										{ className: 'gdw-wizard-client', key: client.clientId || client.path },
										h(
											'div',
											{ className: 'gdw-wizard-client-main' },
											h(
												'span',
												{ className: 'gdw-wizard-client-name' },
												client.projectName || client.clientId,
											),
											h('span', { className: 'gdw-wizard-client-id' }, client.clientId || ''),
											client.path
												? h(
														'span',
														{ className: 'gdw-wizard-client-path' },
														tx('wizard.detect.clientFile', { path: client.path }),
													)
												: null,
										),
										h(
											'div',
											{ className: 'gdw-wizard-inline' },
											h('span', { className: 'gdw-tag gdw-tag-active' }, tx('wizard.detect.recommended')),
											h(
												Button,
												{
													variant: picked ? 'primary' : undefined,
													onClick: function () {
														setSelectedClientId(client.clientId || '');
														setPickedClientId('');
														setPickedClientSecret('');
														setPickedFileName('');
														setError('');
													},
												},
												picked ? tx('wizard.detect.selected') : tx('wizard.detect.useThis'),
											),
										),
									);
								})
							: h('div', { className: 'gdw-field-hint' }, tx('wizard.detect.noDesktop')),
						unusable.length
							? h(
									'div',
									{ className: 'gdw-wizard-section' },
									h('div', { className: 'gdw-wizard-note' }, tx('wizard.detect.webClient')),
									unusable.map(function (client) {
										return h(
											'div',
											{ className: 'gdw-wizard-client', key: client.clientId || client.path },
											h(
												'div',
												{ className: 'gdw-wizard-client-main' },
												h(
													'span',
													{ className: 'gdw-wizard-client-name' },
													client.projectName || client.clientId,
												),
												h('span', { className: 'gdw-wizard-client-id' }, client.clientId || ''),
											),
											h('span', { className: 'gdw-tag gdw-tag-error' }, tx('wizard.detect.webClientTag')),
										);
									}),
								)
							: null,
						clients.length ? null : h('div', { className: 'gdw-field-hint' }, tx('wizard.detect.noOAuthClients')),
					);
				}

				/**
				 * The guided route to a Desktop app client: the console steps,
				 * and a file chooser that fills the client id and secret into
				 * the form below.
				 */
				function desktopPanel() {
					var steps = [
						tx('wizard.desktop.step1'),
						tx('wizard.desktop.step2'),
						tx('wizard.desktop.step3'),
						tx('wizard.desktop.step4'),
						tx('wizard.desktop.step5'),
						tx('wizard.desktop.step6'),
					];
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
						h('h3', null, tx('wizard.desktop.title')),
						h('p', { className: 'gdw-wizard-lead' }, tx('wizard.desktop.why')),
						h(
							'ol',
							{ className: 'gdw-wizard-list' },
							steps.map(function (step, index) {
								return h('li', { key: index }, step);
							}),
						),
						h('div', { className: 'gdw-wizard-note' }, tx('wizard.desktop.dont')),
						h(
							'div',
							{ className: 'gdw-wizard-inline' },
							h(
								'a',
								{ href: CREDENTIALS_URL, target: '_blank', rel: 'noreferrer noopener' },
								tx('wizard.desktop.console'),
							),
						),
						h(
							'div',
							{ className: 'gdw-field' },
							h('label', { htmlFor: fileFieldId }, tx('wizard.desktop.file')),
							h('input', {
								id: fileFieldId,
								type: 'file',
								accept: 'application/json,.json',
								onChange: onFileChosen,
							}),
						),
						h('div', { className: 'gdw-field-hint' }, tx('wizard.desktop.fileHint')),
						fileError ? h(Status, { tone: 'error' }, fileError) : null,
						fileWarning ? h(Status, { tone: 'warn' }, fileWarning) : null,
						pickedClientId
							? h(Status, { tone: 'success' }, tx('wizard.desktop.filled', { file: pickedFileName }))
							: null,
					);
				}

				/** The one-click route: let gcloud mint the key. */
				function gcloudSection() {
					var projects = projectList();
					var accounts = accountsFor(currentProject());
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
						h('h3', null, tx('wizard.service.gcloud.title')),
						h('p', { className: 'gdw-wizard-lead' }, tx('wizard.service.gcloud.hint')),
						h(Field, {
							label: tx('oauth.name.label'),
							value: currentName(),
							hint: tx('oauth.name.hint'),
							onChange: function (event) {
								setGcloudName(event.target.value);
							},
						}),
						projects.length
							? h(Field, {
									label: tx('wizard.service.gcloud.project'),
									type: 'select',
									value: currentProject(),
									options: projects.map(function (project) {
										return { value: project.id, label: project.name || project.id };
									}),
									onChange: function (event) {
										setProjectId(event.target.value);
										setServiceEmail('');
									},
								})
							: h('div', { className: 'gdw-field-hint' }, tx('wizard.service.gcloud.noProjects')),
						accounts.length
							? h(Field, {
									label: tx('wizard.service.gcloud.account'),
									type: 'select',
									value: currentAccount(),
									options: accounts.map(function (account) {
										return {
											value: account.email,
											label: account.displayName
												? account.displayName + ' — ' + account.email
												: account.email,
										};
									}),
									onChange: function (event) {
										setServiceEmail(event.target.value);
									},
								})
							: h('div', { className: 'gdw-field-hint' }, tx('wizard.service.gcloud.noAccounts')),
						h(Field, {
							label: tx('service.subject.label'),
							value: gcloudSubject,
							hint: tx('service.subject.hint'),
							onChange: function (event) {
								setGcloudSubject(event.target.value);
							},
						}),
						h(
							'div',
							{ className: 'gdw-toolbar' },
							h(
								Button,
								{
									variant: 'primary',
									icon: 'check',
									disabled: busy || !currentProject() || !currentAccount() || !currentName(),
									onClick: createKey,
								},
								tx('wizard.service.gcloud.create'),
							),
						),
					);
				}

				/** The service-account tab. */
				function serviceTab() {
					return h(
						'div',
						{ className: 'gdw-wizard' },
						gcloudReady()
							? gcloudSection()
							: h(Status, { tone: 'warn' }, gcloudMissingReason()),
						h(
							'div',
							{ className: 'gdw-wizard-section' },
							h('h3', null, tx('wizard.service.manual.title')),
							h(AddAccountDialog, {
								key: 'service',
								embedded: true,
								mode: 'service',
								initialName: defaultAccountName,
								onClose: function () {
									onClose();
								},
								onAdded: function (account) {
									if (onAdded) onAdded(account);
								},
							}),
						),
					);
				}

				/** The buttons under the panel. */
				function footer() {
					return h(
						'div',
						{ className: 'gdw-toolbar' },
						h(
							Button,
							{ variant: 'ghost', disabled: busy, onClick: onClose },
							tx('common.cancel'),
						),
					);
				}

				var content = h(
					'div',
					{ className: 'gdw-wizard' },
					h('style', null, WIZARD_STYLES),
					h('h3', null, tx('wizard.choose.title')),
					h('p', { className: 'gdw-wizard-lead' }, tx('wizard.choose.body')),
					tabBar(),
					detectPanel(),
					error ? h(Status, { tone: 'error' }, error) : null,
					tab === 'oauth' ? oauthTab() : serviceTab(),
				);

				/* Embedded, the wizard is a panel inside the settings section
				 * rather than a dialog of its own. */
				if (props.embedded) return content;

				return h(
					Dialog,
					{ title: tx('wizard.title'), onClose: onClose, busy: busy },
					content,
					h('div', { className: 'gdw-dialog-footer' }, footer()),
				);
			}

			return OnboardingWizard;
		}

		exports.createOnboardingWizard = createOnboardingWizard;
		exports.isOneClickClient = isOneClickClient;
		exports.readClientFile = readClientFile;
		return module.exports;
	},
});
