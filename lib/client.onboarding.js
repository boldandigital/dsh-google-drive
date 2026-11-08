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
			'.gdw-wizard-progress{display:grid;gap:8px;min-width:0}',
			'.gdw-wizard-progress-label{font-size:12px;color:var(--dsw-alias-label-secondary,#667085)}',
			'.gdw-wizard-steps{display:flex;gap:10px;list-style:none;margin:0;padding:0;flex-wrap:wrap}',
			'.gdw-wizard-steps>li{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary,#667085);min-width:0}',
			'.gdw-wizard-steps>li[aria-current=step]{color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb));font-weight:600}',
			'.gdw-wizard-dot{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;',
			'border:1px solid var(--dsw-alias-border-l3,#e5e8ee);font-size:11px;flex-shrink:0;background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.gdw-wizard-steps>li[aria-current=step] .gdw-wizard-dot{border-color:currentColor;',
			'background:color-mix(in srgb,currentColor 14%,var(--dsw-alias-bg-layer-1,#fff));font-weight:700}',
			'.gdw-wizard-choices{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}',
			'.gdw-wizard-choice{display:flex;flex-direction:column;align-items:flex-start;gap:5px;text-align:start;min-width:0;',
			'background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l3,#e5e8ee);border-radius:10px;',
			'padding:14px 15px;cursor:pointer;color:inherit}',
			'.gdw-wizard-choice:not(:disabled):hover{border-color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb))}',
			'.gdw-wizard-choice[aria-checked=true]{border-color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb));',
			'background:color-mix(in srgb,var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb)) 8%,var(--dsw-alias-bg-layer-1,#fff))}',
			'.gdw-wizard-choice-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1b2430)}',
			'.gdw-wizard-choice-sub{font-size:13px;color:var(--dsw-alias-label-secondary,#667085);line-height:1.55}',
			'.gdw-wizard-choice-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#667085);opacity:.85}',
			'.gdw-wizard-section{display:grid;gap:10px;min-width:0}',
			'.gdw-wizard-section>h3{font-size:14px;font-weight:600}',
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

				/* 1 = choose a method, 2 = set the access up, 3 = done. */
				var [step, setStep] = React.useState(1);
				var [choice, setChoice] = React.useState('');
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
				var [showManual, setShowManual] = React.useState(false);
				var [projectId, setProjectId] = React.useState('');
				var [serviceEmail, setServiceEmail] = React.useState('');
				var [gcloudName, setGcloudName] = React.useState('');
				var [gcloudSubject, setGcloudSubject] = React.useState('');
				var [busy, setBusy] = React.useState(false);
				var [error, setError] = React.useState('');
				var [doneName, setDoneName] = React.useState('');

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
				 * Move to the step that belongs to the chosen method.
				 *
				 * @param {string} value - the chosen method.
				 */
				function choose(value) {
					setChoice(value);
					setError('');
					setShowManual(value !== 'gcloud' && !gcloudReady());
					setStep(2);
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
						event.currentTarget.querySelectorAll('button[role="radio"]'),
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
							setDoneName((account && account.name) || name);
							if (onAdded) onAdded(account);
							setStep(3);
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

				/** The progress indicator above the steps. */
				function progress() {
					var labels = [tx('wizard.step.1'), tx('wizard.step.2'), tx('wizard.step.3')];
					return h(
						'div',
						{ className: 'gdw-wizard-progress' },
						h(
							'div',
							{ className: 'gdw-wizard-progress-label' },
							tx('wizard.step.label', { current: step, total: labels.length }),
						),
						h(
							'ol',
							{ className: 'gdw-wizard-steps', 'aria-label': tx('wizard.progress') },
							labels.map(function (label, index) {
								var number = index + 1;
								return h(
									'li',
									{ key: number, 'aria-current': step === number ? 'step' : undefined },
									h('span', { className: 'gdw-wizard-dot', 'aria-hidden': true }, String(number)),
									h('span', null, label),
								);
							}),
						),
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

				/** Step 1: how do you want to connect? */
				function stepOne() {
					var options = [
						{
							id: 'oauth',
							title: tx('wizard.option.oauth.title'),
							sub: tx('wizard.option.oauth.sub'),
							hint: tx('wizard.option.oauth.hint'),
						},
						{
							id: 'service',
							title: tx('wizard.option.service.title'),
							sub: tx('wizard.option.service.sub'),
							hint: tx('wizard.option.service.hint'),
						},
					];
					if (gcloudReady()) {
						options.push({
							id: 'gcloud',
							title: tx('wizard.option.gcloud.title'),
							sub: tx('wizard.option.gcloud.sub'),
							hint: tx('wizard.option.gcloud.hint'),
						});
					}
					return h(
						'div',
						{ className: 'gdw-wizard' },
						h('h3', null, tx('wizard.choose.title')),
						h('p', { className: 'gdw-wizard-lead' }, tx('wizard.choose.body')),
						h(
							'div',
							{
								className: 'gdw-wizard-choices',
								role: 'radiogroup',
								'aria-label': tx('wizard.choose.group'),
								onKeyDown: onChoiceKeyDown,
							},
							options.map(function (option) {
								return h(
									'button',
									{
										type: 'button',
										role: 'radio',
										key: option.id,
										'aria-checked': choice === option.id ? 'true' : 'false',
										className:
											'gdw-wizard-choice' + (choice === option.id ? ' gdw-wizard-choice-on' : ''),
										onClick: function () {
											choose(option.id);
										},
									},
									h('span', { className: 'gdw-wizard-choice-title' }, option.title),
									h('span', { className: 'gdw-wizard-choice-sub' }, option.sub),
									h('span', { className: 'gdw-wizard-choice-hint' }, option.hint),
								);
							}),
						),
						detectPanel(),
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

				/** Step 2 for the OAuth route. */
				function stepOAuth() {
					return h(
						'div',
						{ className: 'gdw-wizard' },
						h('h3', null, tx('wizard.step.2')),
						desktopPanel(),
						detectedClients(),
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
								onClose: function () {
									setStep(3);
								},
								onAdded: function (account) {
									setDoneName((account && account.name) || '');
									if (onAdded) onAdded(account);
								},
							}),
						),
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

				/** Step 2 for the service-account route. */
				function stepService() {
					return h(
						'div',
						{ className: 'gdw-wizard' },
						h('h3', null, tx('wizard.step.2')),
						gcloudReady()
							? gcloudSection()
							: h(Status, { tone: 'warn' }, gcloudMissingReason()),
						h(
							'div',
							{ className: 'gdw-wizard-section' },
							h('h3', null, tx('wizard.service.manual.title')),
							h(
								'div',
								{ className: 'gdw-toolbar' },
								h(
									Button,
									{
										icon: showManual ? 'left' : 'file',
										onClick: function () {
											setShowManual(!showManual);
										},
									},
									showManual
										? tx('wizard.service.manual.hide')
										: tx('wizard.service.manual.show'),
								),
							),
							showManual
								? h(AddAccountDialog, {
										key: 'service',
										embedded: true,
										mode: 'service',
										onClose: function () {
											setStep(3);
										},
										onAdded: function (account) {
											setDoneName((account && account.name) || '');
											if (onAdded) onAdded(account);
										},
									})
								: null,
						),
					);
				}

				/** Step 3: it worked. */
				function stepDone() {
					return h(
						'div',
						{ className: 'gdw-wizard' },
						h(
							'div',
							{ className: 'gdw-wizard-done' },
							h(Icon, { name: 'check', size: 26 }),
							h('h3', null, tx('wizard.done.title')),
							h(
								'p',
								{ className: 'gdw-wizard-lead' },
								doneName
									? tx('wizard.done.body', { name: doneName })
									: tx('wizard.done.generic'),
							),
						),
					);
				}

				/** The buttons under the current step. */
				function footer() {
					if (step === 3) {
						return h(
							Button,
							{ variant: 'primary', icon: 'check', onClick: onClose },
							tx('wizard.done.action'),
						);
					}
					return h(
						'div',
						{ className: 'gdw-toolbar' },
						step === 2
							? h(
									Button,
									{
										icon: 'left',
										disabled: busy,
										onClick: function () {
											setStep(1);
										},
									},
									tx('wizard.back'),
								)
							: null,
						h(
							Button,
							{ variant: 'ghost', disabled: busy, onClick: onClose },
							tx('common.cancel'),
						),
					);
				}

				return h(
					Dialog,
					{ title: tx('wizard.title'), onClose: onClose, busy: busy },
					h('style', null, WIZARD_STYLES),
					progress(),
					error ? h(Status, { tone: 'error' }, error) : null,
					step === 1 ? stepOne() : step === 2 ? (choice === 'oauth' ? stepOAuth() : stepService()) : stepDone(),
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
