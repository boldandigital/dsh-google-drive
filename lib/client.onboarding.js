/**
 * dsh-google-drive — guided onboarding wizard (browser chunk).
 *
 * The wizard asks one question at a time and only ever shows one screen:
 *
 *   1. "How do you want to connect?" — one primary card for the way almost
 *      everybody connects (their own Google account), and a closed
 *      disclosure for the two ways that need a Google Cloud project.
 *      Nobody has to know what an OAuth client is before they can pick a
 *      path, and the two rare routes cannot be mistaken for the common one.
 *   2. "Do this" — the route that fits, as numbered steps with one action
 *      per step. The steps that need the Google console are short, and the
 *      file that fills the form in is chosen from the same screen.
 *   3. Done.
 *
 * Two things the wizard says before the user clicks anything, because both
 * of them stop a first-time user dead otherwise:
 *
 *   - Google shows "Google hasn't verified this app" for every client that
 *     is not published, and refuses anyone who is not on the test-user list.
 *     Both are expected, so both are scripted steps next to the button the
 *     user is about to press — not grey footer text, and not an error the
 *     user only meets afterwards.
 *   - Letting a service account act as a Workspace user is a
 *     super-administrator task that Google can take up to a day to apply.
 *     That route therefore offers the user something they can actually do:
 *     send a short block of details to their administrator.
 *
 * This file is a browser *chunk*, not a bundle: the module loader serves it
 * from the package's `lib/` folder next to `client.js`, and `lib/client.js`
 * pulls it in with `require.async('./client.onboarding.js')`. The file name
 * is forced by the loader — a package-local chunk must match
 * `client.<name>.js`, so `client-onboarding.js` could never be served.
 *
 * Everything the wizard shares with the main bundle — the translator, the
 * RPC helper and the shared UI components — is handed in by `lib/client.js`
 * as `deps`.
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

		/**
		 * Where the sign-in details are created.
		 *
		 * The console moved this page: "Credentials" is now "Google Auth
		 * Platform → Clients", and the old address sends the user to a Google
		 * sign-in page before it shows anything at all.
		 */
		var CREDENTIALS_URL = 'https://console.cloud.google.com/auth/clients';

		/** Where a service account is created. */
		var SERVICE_ACCOUNTS_URL = 'https://console.cloud.google.com/iam-admin/serviceaccounts';

		/**
		 * The permission a Workspace administrator has to allow.
		 *
		 * This is the same scope the host asks for by default; the admin
		 * needs it spelled out, because the admin console wants the exact
		 * string.
		 */
		var WORKSPACE_SCOPE = 'https://www.googleapis.com/auth/drive';

		/**
		 * The names of the three steps of the wizard.
		 *
		 * The step list is written out rather than built from a number, so
		 * that every step name is a real string in the dictionary.
		 */
		var STEP_NAMES = ['wizard.step.1', 'wizard.step.2', 'wizard.step.3'];

		/** How often the sign-in is checked for an answer. */
		var OAUTH_POLL_MS = 2000;

		/** How many failed checks end the sign-in. */
		var OAUTH_MAX_POLL_FAILURES = 3;

		/**
		 * The wizard's own styles. Only `--dsw-alias-*` / `--dsw-*` custom
		 * properties are used, each with a literal fallback, and every class
		 * carries the `gdw-` prefix.
		 */
		var WIZARD_STYLES = [
			'.gdw-wizard{display:grid;gap:16px;min-width:0}',
			'.gdw-wizard-lead{font-size:13px;color:var(--dsw-alias-label-secondary,#667085);line-height:1.6}',
			'.gdw-wizard-section{display:grid;gap:10px;min-width:0}',
			'.gdw-wizard-section>h3{font-size:14px;font-weight:600}',
			'.gdw-wizard-choices{display:grid;gap:10px;min-width:0}',
			'.gdw-wizard-choice{display:flex;gap:12px;align-items:flex-start;text-align:start;width:100%;cursor:pointer;',
			'background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l3,#e5e8ee);',
			'border-radius:10px;padding:12px 14px;min-width:0}',
			'.gdw-wizard-choice:hover{border-color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb))}',
			'.gdw-wizard-choice[aria-pressed=true]{border-color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb));',
			'background:color-mix(in srgb,var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb)) 6%,var(--dsw-alias-bg-layer-1,#fff))}',
			/* The one card most people need is the one that is offered first. */
			'.gdw-wizard-choice[data-primary=true]{border-color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb));',
			'background:color-mix(in srgb,var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb)) 6%,var(--dsw-alias-bg-layer-1,#fff))}',
			'.gdw-wizard-choice[data-primary=true] .gdw-wizard-choice-title{font-size:15px}',
			'.gdw-wizard-choice-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}',
			'.gdw-wizard-choice-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.gdw-wizard-choice-sub{font-size:13px;color:var(--dsw-alias-label-secondary,#667085);line-height:1.6}',
			'.gdw-wizard-choice-mark{width:18px;height:18px;border-radius:50%;flex-shrink:0;border:1px solid var(--dsw-alias-border-l3,#e5e8ee);',
			'display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:11px}',
			'.gdw-wizard-choice[aria-pressed=true] .gdw-wizard-choice-mark{background:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb));',
			'border-color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb))}',
			/* The step list: where the user is, and what is still to come. */
			'.gdw-wizard-progress{display:grid;gap:6px;min-width:0}',
			'.gdw-wizard-progress-head{display:flex;gap:8px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}',
			'.gdw-wizard-progress-title,.gdw-wizard-progress-count{font-size:12px;color:var(--dsw-alias-label-secondary,#667085)}',
			'.gdw-wizard-progress-steps{display:flex;gap:8px;list-style:none;margin:0;padding:0;flex-wrap:wrap;min-width:0}',
			'.gdw-wizard-progress-step{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#667085);',
			'padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#e5e8ee);',
			'background:var(--dsw-alias-bg-layer-2,#f6f7f9)}',
			'.gdw-wizard-progress-step-current{font-weight:600;color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb));',
			'border-color:var(--dsh-plugin-workbench-accent,var(--dsw-static-neutral-bluish-600,#4f6bdb))}',
			'.gdw-wizard-steps{display:grid;gap:12px;margin:0;padding:0;list-style:none;counter-reset:gdw-step;min-width:0}',
			'.gdw-wizard-step{display:grid;grid-template-columns:24px minmax(0,1fr);gap:10px;align-items:start;min-width:0}',
			'.gdw-wizard-step-num{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;',
			'border:1px solid var(--dsw-alias-border-l3,#e5e8ee);font-size:11px;flex-shrink:0;background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.gdw-wizard-step-body{min-width:0;display:flex;flex-direction:column;gap:8px}',
			'.gdw-wizard-step-title{font-size:13px;font-weight:600;line-height:1.5}',
			'.gdw-wizard-list{display:grid;gap:6px;margin:0;padding-left:20px;font-size:13px;line-height:1.6;',
			'color:var(--dsw-alias-label-primary,#1b2430);min-width:0}',
			'.gdw-wizard-list>li{min-width:0;overflow-wrap:anywhere}',
			'.gdw-wizard-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-warn-primary,#8a5a00);overflow-wrap:anywhere}',
			'.gdw-wizard-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#667085);overflow-wrap:anywhere}',
			'.gdw-wizard-client{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;min-width:0;',
			'border:1px solid var(--dsw-alias-border-l3,#e5e8ee);border-radius:8px;padding:10px 12px;',
			'background:var(--dsw-alias-bg-layer-2,#f6f7f9)}',
			'.gdw-wizard-client-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}',
			'.gdw-wizard-client-name{font-size:14px;font-weight:600;overflow-wrap:anywhere}',
			'.gdw-wizard-client-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
			'color:var(--dsw-alias-label-secondary,#667085);overflow-wrap:anywhere}',
			'.gdw-wizard-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}',
			'.gdw-wizard-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}',
			'.gdw-wizard-details{border:1px solid var(--dsw-alias-border-l3,#e5e8ee);border-radius:8px;padding:0;min-width:0}',
			'.gdw-wizard-details>summary{cursor:pointer;padding:10px 12px;font-size:13px;font-weight:600;list-style:revert}',
			'.gdw-wizard-details>div{padding:0 12px 12px;display:grid;gap:10px;min-width:0}',
			/* The block the user sends to their administrator. */
			'.gdw-wizard-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.7;',
			'background:var(--dsw-alias-bg-layer-2,#f6f7f9);border:1px solid var(--dsw-alias-border-l3,#e5e8ee);',
			'border-radius:8px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}',
			'.gdw-wizard-raw{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;',
			'overflow-wrap:anywhere;min-width:0}',
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
		 * A name the account can be filed under for the few seconds between
		 * "start the sign-in" and "Google says which address signed in".
		 *
		 * The host needs a name when the sign-in starts, but the name the
		 * user will recognise is the address they signed in with — and that
		 * is only known afterwards. So the sign-in gets a throw-away name and
		 * the account is renamed once the address is known.
		 *
		 * @returns {string} a name nothing else is likely to use.
		 */
		function temporaryAccountName() {
			return 'drive-' + Date.now().toString(36).slice(-6);
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

			/**
			 * The guided add-account wizard.
			 *
			 * @param {object} props - the component props.
			 * @returns {object} the rendered wizard.
			 */
			function OnboardingWizard(props) {
				var onClose = props.onClose;
				var onAdded = props.onAdded;

				/* The situation the user picked: 'oauth' | 'service' | 'workspace'. */
				var [route, setRoute] = React.useState('');
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
				var keyFieldId = React.useId();
				/* The client id the form is filled with: the picked file wins. */
				var effectiveClientId = pickedClientId || selectedClientId;
				var [projectId, setProjectId] = React.useState('');
				var [serviceEmail, setServiceEmail] = React.useState('');
				var [gcloudName, setGcloudName] = React.useState('');
				var [gcloudSubject, setGcloudSubject] = React.useState('');
				var [busy, setBusy] = React.useState(false);
				var [error, setError] = React.useState('');

				/* The sign-in form state. */
				var [oauthName, setOauthName] = React.useState('');
				var [clientSecret, setClientSecret] = React.useState('');
				var [oauth, setOauth] = React.useState({ state: 'idle' });
				var flowRef = React.useRef(null);
				var pollFailures = React.useRef(0);
				/* The window that was opened for the sign-in page. */
				var popupRef = React.useRef(null);
				var [autoOpenBlocked, setAutoOpenBlocked] = React.useState(false);

				/* The service-account form state. */
				var [serviceName, setServiceName] = React.useState('google');
				var [keyJson, setKeyJson] = React.useState('');
				var [subject, setSubject] = React.useState('');
				/* The keys that were already live on the service account. */
				var [otherKeys, setOtherKeys] = React.useState([]);
				/* Whether the administrator block was copied to the clipboard. */
				var [copied, setCopied] = React.useState('');

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
							/* One usable client on this machine is the one the
							 * user wants: pick it, so the sign-in is one click
							 * long. */
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

				/* Poll the sign-in until Google answers. */
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
									finishSignIn(value.account || null);
									return;
								}
								if (status === 'failed') {
									setOauth({
										state: 'failed',
										message: (value && value.message) || tx('oauth.failed', { message: '' }),
									});
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

				/**
				 * Read a downloaded JSON file in the browser and fill the form
				 * in. Nothing leaves the machine: the file is read here and
				 * never sent anywhere except to the host that stores it.
				 *
				 * @param {object} event - the file input's change event.
				 * @param {function} fill - what to do with the parsed file.
				 */
				function onFileChosen(event, fill) {
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
						fill(parsed, file);
					};
					reader.onerror = function () {
						setFileError(tx('wizard.desktop.failed', { message: '' }));
					};
					reader.readAsText(file);
				}

				/**
				 * Fill the sign-in form from a downloaded OAuth client file.
				 *
				 * @param {object} parsed - the parsed file.
				 * @param {object} file - the file itself.
				 */
				function onClientFile(parsed, file) {
					var client = readClientFile(parsed);
					if (!client.clientId || !client.clientSecret) {
						setFileError(tx('wizard.desktop.noClient'));
						return;
					}
					setPickedClientId(client.clientId);
					setPickedClientSecret(client.clientSecret);
					setPickedFileName(file.name || '');
					setSelectedClientId(client.clientId);
					setClientSecret(client.clientSecret);
					if (client.type === 'web') {
						setFileWarning(tx('wizard.desktop.webOnly'));
					}
				}

				/**
				 * Fill the service-account form from a downloaded key file.
				 *
				 * @param {object} parsed - the parsed file.
				 * @param {object} file - the file itself.
				 */
				function onKeyFile(parsed, file) {
					if (!parsed || typeof parsed !== 'object' || parsed.type !== 'service_account') {
						setFileError(tx('wizard.service.key.badFile'));
						return;
					}
					setKeyJson(JSON.stringify(parsed, null, 2));
					setPickedFileName(file.name || '');
					setFileError('');
				}

				/**
				 * The service-account key the user pasted or chose.
				 *
				 * @returns {object|null} the parsed key, or null.
				 */
				function parsedKey() {
					if (!keyJson.trim()) return null;
					try {
						var parsed = JSON.parse(keyJson);
						return parsed && typeof parsed === 'object' ? parsed : null;
					} catch (error) {
						return null;
					}
				}

				/**
				 * The address a service account's key belongs to.
				 *
				 * The user has to share the folder with exactly this address, so
				 * it is worth reading out of the key they pasted.
				 *
				 * @returns {string} the address, or an empty string.
				 */
				function parsedKeyEmail() {
					var key = parsedKey();
					return key && typeof key.client_email === 'string' ? key.client_email : '';
				}

				/**
				 * The number a Workspace administrator has to allow.
				 *
				 * The admin console asks for the numeric client id of the
				 * service account, not for the app's own client id, so it is
				 * read out of the key the user chose.
				 *
				 * @returns {string} the client id, or an empty string.
				 */
				function parsedKeyClientId() {
					var key = parsedKey();
					return key && typeof key.client_id === 'string' ? key.client_id : '';
				}

				/**
				 * Which kind of refusal Google reported.
				 *
				 * The raw answer from Google is a piece of protocol, and the
				 * user cannot act on it. Each refusal gets a plain sentence
				 * and, where the route is a dead end, a way out.
				 *
				 * @param {string} message - the message the host reported.
				 * @returns {string} the kind of refusal.
				 */
				function oauthErrorKind(message) {
					var text = String(message || '').toLowerCase();
					if (!text) return 'unknown';
					if (text.includes('org_internal')) return 'orgInternal';
					if (text.includes('invalid_client')) return 'invalidClient';
					if (text.includes('not verified') || text.includes('unverified')) return 'unverified';
					if (text.includes('access_denied') || text.includes('access denied')) return 'accessDenied';
					if (text.includes('redirect_uri_mismatch') || text.includes('redirect')) return 'redirect';
					if (text.includes('admin_policy_enforced') || text.includes('blocked')) return 'admin';
					if (text.includes('invalid_grant') || text.includes('expired')) return 'invalidGrant';
					return 'unknown';
				}

				/**
				 * The plain-language explanation of one refusal.
				 *
				 * @param {string} kind - the kind of refusal.
				 * @returns {string} the sentence the user reads first.
				 */
				function oauthHintText(kind) {
					if (kind === 'unverified') return tx('wizard.oauth.hint.unverified');
					if (kind === 'accessDenied') return tx('wizard.oauth.hint.testUser');
					if (kind === 'redirect') return tx('wizard.oauth.hint.redirect');
					if (kind === 'admin') return tx('wizard.oauth.hint.admin');
					if (kind === 'orgInternal') return tx('wizard.oauth.hint.orgInternal');
					if (kind === 'invalidClient') return tx('wizard.oauth.hint.invalidClient');
					if (kind === 'invalidGrant') return tx('wizard.oauth.hint.invalidGrant');
					return tx('wizard.oauth.hint.unknown');
				}

				/**
				 * Start the sign-in.
				 *
				 * The browser is opened from the click itself: a pop-up
				 * blocker only lets a window open in the same tick as the
				 * click, so a blank window is opened first and pointed at the
				 * sign-in page as soon as the host has built the URL.
				 */
				function startAuthorization() {
					if (busy) return;
					setError('');
					setOauth({ state: 'starting' });
					setBusy(true);
					setAutoOpenBlocked(false);
					var win = openBlankWindow();
					var wanted = oauthName.trim();
					/* The host needs a name when the sign-in starts. When the
					 * user did not choose one, a throw-away name is used and
					 * the account is renamed to the signed-in address as soon
					 * as Google tells us what it is. */
					rpc('oauth/start', {
						name: wanted === '' ? temporaryAccountName() : sanitizeName(wanted),
						clientId: effectiveClientId,
						clientSecret: clientSecret,
					})
						.then(function (value) {
							flowRef.current = (value && value.flowId) || null;
							pollFailures.current = 0;
							if (!flowRef.current) {
								setOauth({ state: 'failed', message: tx('oauth.failed', { message: '' }) });
								return;
							}
							var url = (value && value.authUrl) || '';
							setOauth({ state: 'pending', authUrl: url });
							if (win) {
								if (!pointWindowAt(win, url)) setAutoOpenBlocked(true);
							} else {
								setAutoOpenBlocked(true);
							}
						})
						.catch(function (startError) {
							/* The blank window has nothing to show now. */
							closeBlankWindow();
							setOauth({ state: 'failed', message: startError.message });
						})
						.finally(function () {
							setBusy(false);
						});
				}

				/**
				 * Open an empty browser window.
				 *
				 * @returns {object|null} the window, or null when the browser
				 * refused to open one.
				 */
				function openBlankWindow() {
					try {
						if (typeof window === 'undefined' || typeof window.open !== 'function') return null;
						popupRef.current = window.open('', '_blank');
					} catch (error) {
						popupRef.current = null;
					}
					return popupRef.current;
				}

				/**
				 * Close the window that was opened for the sign-in.
				 *
				 * A window that is left open with nothing in it only confuses the
				 * user, so it is closed when the sign-in never started.
				 */
				function closeBlankWindow() {
					var win = popupRef.current;
					popupRef.current = null;
					if (!win) return;
					try {
						win.close();
					} catch (error) {
						/* A window the browser owns is not ours to close. */
					}
				}

				/**
				 * Send the window that was opened for the sign-in to the
				 * sign-in page.
				 *
				 * @param {object} win - the window.
				 * @param {string} url - the sign-in page.
				 * @returns {boolean} whether the window could be pointed at it.
				 */
				function pointWindowAt(win, url) {
					if (!win || !url) return false;
					try {
						win.location.href = url;
						return true;
					} catch (error) {
						return false;
					}
				}

				/**
				 * Open the sign-in page in a browser window.
				 *
				 * This is the fallback for the case where the browser
				 * refused to open a window by itself.
				 */
				function openSignInPage() {
					var url = oauth.authUrl || '';
					if (!url) return;
					var win = popupRef.current;
					if (win && pointWindowAt(win, url)) return;
					try {
						if (typeof window !== 'undefined' && typeof window.open === 'function') {
							window.open(url, '_blank', 'noopener');
						}
					} catch (error) {
						/* The link below is always there as a last resort. */
					}
				}

				/**
				 * Finish a sign-in and file the account under a name the user
				 * recognises.
				 *
				 * The account is created under the name the sign-in started
				 * with. When the user did not choose a name, the address they
				 * signed in with is the name they will recognise, so the
				 * account is renamed to it here.
				 *
				 * @param {object} account - the account the host created.
				 */
				function finishSignIn(account) {
					var current = account && account.name ? account.name : '';
					var wanted = sanitizeName(oauthName.trim());
					var derived =
						account && account.email ? sanitizeName(String(account.email).split('@')[0]) : '';
					var target = wanted || derived;
					if (!account || !current || !target || target === current) {
						completeSignIn(account);
						return;
					}
					rpc('accounts/update', { name: current, newName: target })
						.then(function (value) {
							completeSignIn((value && value.account) || account);
						})
						.catch(function () {
							/* The name may already be taken by another
							 * account. A numbered variant still says what the
							 * account is. */
							var alternative = target + '-2';
							if (alternative === current) {
								completeSignIn(account);
								return;
							}
							rpc('accounts/update', { name: current, newName: alternative })
								.then(function (value) {
									completeSignIn((value && value.account) || account);
								})
								.catch(function () {
									completeSignIn(account);
								});
						});
				}

				/**
				 * Hand the finished account to the caller and close.
				 *
				 * @param {object} account - the account the host created.
				 */
				function completeSignIn(account) {
					setOauth({ state: 'authorized', account: account || null });
					if (onAdded) onAdded(account || null);
					onClose();
				}

				/**
				 * Stop the sign-in.
				 */
				function cancelAuthorization() {
					var flowId = flowRef.current;
					setOauth({ state: 'idle' });
					flowRef.current = null;
					if (!flowId) return;
					rpc('oauth/cancel', { flowId: flowId }).catch(function () {
						/* Cancelling is best-effort: the host expires the flow anyway. */
					});
				}

				/**
				 * Forget the sign-in details of the route the user is on.
				 *
				 * A refusal that comes from the company's own administrator
				 * or from the company's Cloud organisation cannot be fixed by
				 * trying again with the same details.
				 */
				function usePersonalAccount() {
					setPickedClientId('');
					setPickedClientSecret('');
					setPickedFileName('');
					setSelectedClientId('');
					setClientSecret('');
					setFileError('');
					setFileWarning('');
					setOauth({ state: 'idle' });
					setError('');
					setRoute('oauth');
				}

				/**
				 * The other way out of a refusal.
				 *
				 * A dead end without an exit is a dead end the user cannot
				 * leave, so every refusal that the current route cannot fix
				 * carries a named alternative.
				 *
				 * @param {string} kind - the kind of refusal.
				 * @returns {object[]} the buttons to offer.
				 */
				function alternativeExits(kind) {
					var shared = {
						label: tx('wizard.oauth.alt.shared'),
						action: function () {
							setError('');
							setRoute('service');
						},
					};
					var personal = {
						label: tx('wizard.oauth.alt.personal'),
						action: usePersonalAccount,
					};
					if (kind === 'accessDenied') return [shared];
					if (kind === 'orgInternal') return [personal, shared];
					if (kind === 'admin') return [personal, shared];
					if (kind === 'invalidClient') return [shared];
					return [];
				}

				/**
				 * Store the pasted service-account key.
				 */
				function addServiceAccount() {
					if (busy) return;
					setError('');
					setBusy(true);
					rpc('accounts/add-service', {
						name: serviceName.trim(),
						keyJson: keyJson,
						subject: subject.trim() ? subject.trim() : undefined,
					})
						.then(function (value) {
							if (onAdded) onAdded((value && value.account) || null);
							onClose();
						})
						.catch(function (addError) {
							setError(addError.message);
						})
						.finally(function () {
							setBusy(false);
						});
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
							/* A key that was minted before is still live in
							 * Google, and this plugin does not own it: the user
							 * is told which ones are left over. */
							var others = (value && value.otherKeys) || [];
							if (others.length) setOtherKeys(others);
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
				 * Copy a block of text to the clipboard.
				 *
				 * @param {string} text - the text to copy.
				 */
				function copyText(text) {
					var clipboard = typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
					if (!clipboard || !clipboard.writeText) {
						setCopied('failed');
						return;
					}
					clipboard.writeText(text).then(
						function () {
							setCopied('copied');
						},
						function () {
							setCopied('failed');
						},
					);
				}

				/* ---------------------------------------------------------------- *
				 * The pieces of the wizard                                       *
				 * ---------------------------------------------------------------- */

				/**
				 * A collapsed block that keeps the technical words out of the
				 * way until somebody asks for them.
				 *
				 * @param {string} summary - what the collapsed block says.
				 * @param {object} children - what is inside the block.
				 * @returns {object} the rendered block.
				 */
				function details(summary, children) {
					return h(
						'details',
						{ className: 'gdw-wizard-details' },
						h('summary', null, summary),
						h('div', null, children),
					);
				}

				/**
				 * The list of steps, with the one the user is on highlighted.
				 *
				 * @returns {object} the rendered step list.
				 */
				function progressIndicator() {
					var current = route ? 2 : 1;
					return h(
						'div',
						{ className: 'gdw-wizard-progress' },
						h(
							'div',
							{ className: 'gdw-wizard-progress-head' },
							h('span', { className: 'gdw-wizard-progress-title' }, tx('wizard.progress')),
							h(
								'span',
								{ className: 'gdw-wizard-progress-count' },
								tx('wizard.step.label', { current: String(current), total: '3' }),
							),
						),
						h(
							'ol',
							{ className: 'gdw-wizard-progress-steps' },
							[1, 2, 3].map(function (number) {
								return h(
									'li',
									{
										key: String(number),
										className:
											'gdw-wizard-progress-step' +
											(number === current ? ' gdw-wizard-progress-step-current' : ''),
										'aria-current': number === current ? 'step' : undefined,
									},
									tx(STEP_NAMES[number - 1]),
								);
							}),
						),
					);
				}

				/**
				 * One choice card.
				 *
				 * @param {object} options - the card's data.
				 * @returns {object} the rendered card.
				 */
				function choiceCard(options) {
					var picked = route === options.id;
					return h(
						'button',
						{
							type: 'button',
							className: 'gdw-wizard-choice',
							'aria-pressed': picked ? 'true' : 'false',
							'data-primary': options.primary ? 'true' : undefined,
							onClick: function () {
								setRoute(options.id);
								setError('');
							},
						},
						h('span', { className: 'gdw-wizard-choice-mark' }, picked ? '✓' : ''),
						h(
							'span',
							{ className: 'gdw-wizard-choice-main' },
							h(
								'span',
								{ className: 'gdw-wizard-choice-title' },
								options.title,
								options.tag ? h('span', { className: 'gdw-tag gdw-tag-active' }, options.tag) : null,
							),
							h('span', { className: 'gdw-wizard-choice-sub' }, options.sub),
						),
					);
				}

				/**
				 * The situation chooser.
				 *
				 * One card is offered as the way in, and the two ways that
				 * need a Google Cloud project stay behind a closed
				 * disclosure: a first-time user has no way of telling which
				 * of the three fits their situation, and picking the wrong
				 * one costs them an afternoon.
				 *
				 * @returns {object} the rendered chooser.
				 */
				function chooser() {
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
						h('h3', null, tx('wizard.choose.title')),
						h('p', { className: 'gdw-wizard-lead' }, tx('wizard.choose.body')),
						h(
							'div',
							{ className: 'gdw-wizard-choices' },
							choiceCard({
								id: 'oauth',
								primary: true,
								title: tx('wizard.option.oauth.title'),
								sub: tx('wizard.option.oauth.sub'),
								tag: tx('wizard.option.oauth.tag'),
							}),
						),
						h(
							'details',
							{ className: 'gdw-wizard-details' },
							h('summary', null, tx('wizard.choose.other')),
							h(
								'div',
								null,
								h(
									'div',
									{ className: 'gdw-wizard-choices' },
									choiceCard({
										id: 'service',
										title: tx('wizard.option.service.title'),
										sub: tx('wizard.option.service.sub'),
										tag: tx('wizard.option.service.tag'),
									}),
									choiceCard({
										id: 'workspace',
										title: tx('wizard.option.workspace.title'),
										sub: tx('wizard.option.workspace.sub'),
									}),
								),
								h('p', { className: 'gdw-wizard-hint' }, tx('wizard.choose.otherHint')),
							),
						),
						detect.state === 'loading'
							? h('div', { className: 'gdw-wizard-hint' }, tx('wizard.detect.scanningBrief'))
							: null,
					);
				}

				/**
				 * One numbered step.
				 *
				 * @param {object} options - the step's data.
				 * @returns {object} the rendered step.
				 */
				function step(options) {
					return h(
						'li',
						{ className: 'gdw-wizard-step' },
						h('span', { className: 'gdw-wizard-step-num' }, String(options.number)),
						h(
							'span',
							{ className: 'gdw-wizard-step-body' },
							h('span', { className: 'gdw-wizard-step-title' }, options.title),
							options.children || null,
						),
					);
				}

				/**
				 * The clients this machine already has.
				 *
				 * A Desktop app client is offered as a one-click choice; a web
				 * client is listed as what it is — not usable here — because
				 * offering it would fail at the consent screen.
				 *
				 * @returns {object} the rendered list, or null.
				 */
				function detectedClients() {
					var clients = oauthClients();
					var usable = clients.filter(isOneClickClient);
					var unusable = clients.filter(function (client) {
						return !isOneClickClient(client);
					});
					if (!clients.length) return null;
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
						h('h3', null, tx('wizard.detect.oauthClients')),
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
										),
										h(
											'div',
											{ className: 'gdw-wizard-inline' },
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
							: null,
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
					);
				}

				/**
				 * The sign-in route.
				 *
				 * @returns {object} the rendered route.
				 */
				function oauthRoute() {
					var found = detectedClients();
					var kind = oauthErrorKind(oauth.message || '');
					var exits = alternativeExits(kind);
					return h(
						'div',
						{ className: 'gdw-wizard' },
						detect.state === 'error' && detectError
							? h(
									'div',
									{ className: 'gdw-wizard-section' },
									h(Status, { tone: 'warn' }, detectError),
									h(
										'div',
										{ className: 'gdw-wizard-inline' },
										h(
											Button,
											{ icon: 'refresh', disabled: detect.state === 'loading', onClick: scan },
											tx('wizard.detect.rescan'),
										),
									),
								)
							: null,
						detect.state === 'loading' && !found
							? h('div', { className: 'gdw-wizard-hint' }, tx('wizard.detect.scanning'))
							: null,
						found,
						h(
							'ol',
							{ className: 'gdw-wizard-steps' },
							step({
								number: 1,
								title: tx('wizard.oauth.step1'),
								children: h(
									'div',
									{ className: 'gdw-wizard-section' },
									h(
										'ol',
										{ className: 'gdw-wizard-list' },
										h('li', null, tx('wizard.oauth.step1a')),
										h('li', null, tx('wizard.oauth.step1b')),
										h('li', null, tx('wizard.oauth.step1c')),
										h('li', null, tx('wizard.oauth.step1d')),
										h('li', null, tx('wizard.oauth.step1e')),
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
											onChange: function (event) {
												onFileChosen(event, onClientFile);
											},
										}),
									),
									h('div', { className: 'gdw-wizard-hint' }, tx('wizard.desktop.fileHint')),
									fileError ? h(Status, { tone: 'error' }, fileError) : null,
									fileWarning ? h(Status, { tone: 'warn' }, fileWarning) : null,
									pickedClientId
										? h(Status, { tone: 'success' }, tx('wizard.desktop.filled', { file: pickedFileName }))
										: null,
									details(tx('wizard.oauth.manual.title'), [
										h(
											'div',
											{ className: 'gdw-wizard-section' },
											h(Field, {
												label: tx('oauth.clientId.label'),
												value: selectedClientId,
												onChange: function (event) {
													setSelectedClientId(event.target.value);
													setPickedClientId('');
													setPickedClientSecret('');
													setPickedFileName('');
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
											h('div', { className: 'gdw-wizard-hint' }, tx('wizard.oauth.secretHint')),
										),
									]),
								),
							}),
							step({
								number: 2,
								title: tx('wizard.oauth.step2'),
								children: h(
									'div',
									{ className: 'gdw-wizard-section' },
									h('div', { className: 'gdw-wizard-lead' }, tx('wizard.oauth.permissions')),
									/* The two walls every first-time user hits are
									 * scripted here, right above the button they
									 * are about to press. */
									h('div', { className: 'gdw-wizard-note' }, tx('wizard.oauth.unverified')),
									h('div', { className: 'gdw-wizard-note' }, tx('wizard.oauth.testing')),
									h(
										Field,
										{
											label: tx('wizard.accountName.label'),
											value: oauthName,
											hint: tx('wizard.accountName.hint'),
											placeholder: 'my-drive',
											onChange: function (event) {
												setOauthName(event.target.value);
											},
										},
									),
									h(
										'div',
										{ className: 'gdw-wizard-actions' },
										h(
											Button,
											{
												variant: 'primary',
												icon: 'link',
												disabled: busy || !effectiveClientId || !clientSecret,
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
									autoOpenBlocked
										? h('div', { className: 'gdw-wizard-hint' }, tx('oauth.openBlocked'))
										: null,
									oauth.state === 'failed'
										? h(
												'div',
												{ className: 'gdw-wizard-section' },
												h(Status, { tone: 'error' }, oauthHintText(kind)),
												exits.length
													? h(
															'div',
															{ className: 'gdw-wizard-actions' },
															exits.map(function (exit, index) {
																return h(
																	Button,
																	{
																		key: 'exit-' + String(index),
																		variant: 'primary',
																		onClick: exit.action,
																	},
																	exit.label,
																);
															}),
														)
													: null,
												details(
													tx('wizard.technical'),
													h('div', { className: 'gdw-wizard-raw' }, oauth.message || ''),
												),
											)
										: null,
									oauth.authUrl
										? h(
												'div',
												{ className: 'gdw-wizard-section' },
												h(
													'div',
													{ className: 'gdw-wizard-actions' },
													h(
														Button,
														{ variant: 'primary', icon: 'link', onClick: openSignInPage },
														tx('oauth.openPage'),
													),
													h(
														'a',
														{
															href: oauth.authUrl,
															target: '_blank',
															rel: 'noreferrer noopener',
														},
														tx('oauth.link.label'),
													),
												),
											)
										: null,
								),
							}),
						),
						details(
							tx('wizard.technical'),
							h('div', { className: 'gdw-wizard-raw' }, tx('wizard.oauth.scopeDetail')),
						),
					);
				}

				/**
				 * The service-account route.
				 *
				 * @param {boolean} workspace - whether the Workspace variant is shown.
				 * @returns {object} the rendered route.
				 */
				function serviceRoute(workspace) {
					var clientId = parsedKeyClientId();
					return h(
						'div',
						{ className: 'gdw-wizard' },
						workspace
							? h(Status, { tone: 'warn' }, tx('wizard.workspace.explain'))
							: h(Status, { tone: 'info' }, tx('wizard.service.shared.explain')),
						h(
							'ol',
							{ className: 'gdw-wizard-steps' },
							step({
								number: 1,
								title: workspace ? tx('wizard.workspace.step1') : tx('wizard.service.step1'),
								children: h(
									'div',
									{ className: 'gdw-wizard-section' },
									h(
										'ol',
										{ className: 'gdw-wizard-list' },
										h('li', null, tx('wizard.service.step1a')),
										h('li', null, tx('wizard.service.step1b')),
									),
									h(
										'div',
										{ className: 'gdw-wizard-inline' },
										h(
											'a',
											{
												href: SERVICE_ACCOUNTS_URL,
												target: '_blank',
												rel: 'noreferrer noopener',
											},
											tx('wizard.service.console'),
										),
									),
								),
							}),
							step({
								number: 2,
								title: tx('wizard.service.step2'),
								children: h(
									'div',
									{ className: 'gdw-wizard-section' },
									h(
										'div',
										{ className: 'gdw-field' },
										h('label', { htmlFor: keyFieldId }, tx('wizard.service.key.file')),
										h('input', {
											id: keyFieldId,
											type: 'file',
											accept: 'application/json,.json',
											onChange: function (event) {
												onFileChosen(event, onKeyFile);
											},
										}),
									),
									fileError ? h(Status, { tone: 'error' }, fileError) : null,
									pickedFileName && keyJson
										? h(Status, { tone: 'success' }, tx('wizard.service.key.filled', { file: pickedFileName }))
										: null,
									parsedKeyEmail()
										? h(
												'div',
												{ className: 'gdw-wizard-hint' },
												tx('wizard.service.shareAddress', { email: parsedKeyEmail() }),
											)
										: null,
									/* Pasting a key is the rare way round, so it stays
									 * behind a disclosure. */
									h(
										'details',
										{ className: 'gdw-wizard-details' },
										h('summary', null, tx('wizard.service.pasteInstead')),
										h(
											'div',
											null,
											h(
												Field,
												{
													label: tx('service.key.label'),
													type: 'textarea',
													rows: 6,
													value: keyJson,
													placeholder: '{ "type": "service_account", … }',
													hint: tx('service.key.hint'),
													onChange: function (event) {
														setKeyJson(event.target.value);
													},
												},
											),
										),
									),
									workspace ? adminBlock(clientId) : null,
								),
							}),
							step({
								number: 3,
								title: tx('wizard.service.step3'),
								children: h(
									'div',
									{ className: 'gdw-wizard-section' },
									h(Field, {
										label: tx('oauth.name.label'),
										value: serviceName,
										hint: tx('oauth.name.hint'),
										onChange: function (event) {
											setServiceName(event.target.value);
										},
									}),
									workspace ? impersonationField() : null,
									h(
										'div',
										{ className: 'gdw-wizard-inline' },
										h(
											Button,
											{
												variant: 'primary',
												disabled: busy || !serviceName.trim() || !keyJson.trim(),
												onClick: addServiceAccount,
											},
											tx('service.add'),
										),
									),
								),
							}),
						),
						h(
							'details',
							{ className: 'gdw-wizard-details' },
							h('summary', null, tx('wizard.service.gcloud.title')),
							h(
								'div',
								null,
								h('p', { className: 'gdw-wizard-hint' }, tx('wizard.service.gcloud.hint')),
								gcloudReady() ? gcloudSection() : h(Status, { tone: 'warn' }, gcloudMissingReason()),
							),
						),
					);
				}

				/**
				 * The block the user sends to their administrator.
				 *
				 * Letting a service account act as a Workspace user is a
				 * super-administrator task, and the administrator needs two
				 * exact strings to do it. The user can only do one thing
				 * about it: send the block. So the block is copyable, and
				 * the wait it causes is named.
				 *
				 * @param {string} clientId - the client id of the service account.
				 * @returns {object} the rendered block.
				 */
				function adminBlock(clientId) {
					if (!clientId) return null;
					var block = tx('wizard.workspace.clientId') + ': ' + clientId + '\n' +
						tx('wizard.workspace.scope') + ': ' + WORKSPACE_SCOPE;
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
						h('div', { className: 'gdw-wizard-step-title' }, tx('wizard.workspace.send')),
						h('div', { className: 'gdw-wizard-code' }, block),
						h(
							'div',
							{ className: 'gdw-wizard-inline' },
							h(Button, { icon: 'copy', onClick: function () { copyText(block); } }, tx('wizard.workspace.copy')),
							copied === 'copied' ? h('div', { className: 'gdw-wizard-hint' }, tx('wizard.workspace.copied')) : null,
							copied === 'failed' ? h('div', { className: 'gdw-wizard-hint' }, tx('oauth.copyFailed')) : null,
						),
						h('div', { className: 'gdw-wizard-hint' }, tx('wizard.workspace.delay')),
					);
				}

				/**
				 * The Workspace-user field.
				 *
				 * @returns {object} the rendered field.
				 */
				function impersonationField() {
					return h(
						'div',
						{ className: 'gdw-field' },
						h('label', null, tx('service.subject.label')),
						h('input', {
							type: 'text',
							value: subject,
							placeholder: 'user@your-company.com',
							onChange: function (event) {
								setSubject(event.target.value);
							},
						}),
						h('div', { className: 'gdw-wizard-hint' }, tx('wizard.workspace.subject.hint')),
					);
				}

				/**
				 * The one-click route: let gcloud mint the key.
				 *
				 * @returns {object} the rendered section.
				 */
				function gcloudSection() {
					var projects = projectList();
					var accounts = accountsFor(currentProject());
					return h(
						'div',
						{ className: 'gdw-wizard-section' },
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
							: h('div', { className: 'gdw-wizard-hint' }, tx('wizard.service.gcloud.noProjects')),
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
							: h('div', { className: 'gdw-wizard-hint' }, tx('wizard.service.gcloud.noAccounts')),
						h(Field, {
							label: tx('service.subject.label'),
							value: gcloudSubject,
							hint: tx('wizard.workspace.subject.hint'),
							onChange: function (event) {
								setGcloudSubject(event.target.value);
							},
						}),
						h(
							'div',
							{ className: 'gdw-wizard-inline' },
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
						otherKeys.length
							? h(
									Status,
									{ tone: 'warn' },
									tx('wizard.service.gcloud.otherKeys', { count: String(otherKeys.length) }),
								)
							: null,
					);
				}

				/**
				 * The buttons under the panel.
				 *
				 * @returns {object} the rendered footer.
				 */
				function footer() {
					return h(
						'div',
						{ className: 'gdw-toolbar' },
						route
							? h(
									Button,
									{ variant: 'ghost', disabled: busy, onClick: function () { setRoute(''); } },
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

				var content = h(
					'div',
					{ className: 'gdw-wizard' },
					h('style', null, WIZARD_STYLES),
					progressIndicator(),
					route
						? h(
								'div',
								{ className: 'gdw-wizard-section' },
								h('h3', null, tx('wizard.title')),
								h(
									'div',
									{ className: 'gdw-wizard-section' },
									error ? h(Status, { tone: 'error' }, error) : null,
									route === 'oauth' ? oauthRoute() : serviceRoute(route === 'workspace'),
								),
							)
						: chooser(),
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
