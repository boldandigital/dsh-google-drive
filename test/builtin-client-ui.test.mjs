/**
 * gd-builtin-ui-test.mjs — the built-in OAuth client in the wizard.
 *
 * The wizard is a browser chunk, so it is loaded into a small React
 * stand-in: the same code the browser runs, with a fake host behind it.
 * Every check below is therefore a real render of the real file.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIZARD_FILE = REPO + '/lib/client.onboarding.js';
const CLIENT_FILE = REPO + '/lib/client.js';

/* ------------------------------------------------------------------ *
 * Tiny test runner                                                   *
 * ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
let currentName = '';

function ok(condition, message) {
	if (condition) {
		passed += 1;
		return true;
	}
	failures.push(currentName + ' :: ' + message);
	return false;
}

function eq(actual, expected, message) {
	return ok(
		Object.is(actual, expected),
		message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')',
	);
}

async function test(name, fn) {
	currentName = name;
	try {
		await fn();
	} catch (error) {
		failures.push(name + ' :: threw ' + (error && error.stack ? error.stack : String(error)));
	}
}

/* ------------------------------------------------------------------ *
 * The locale dictionary, read out of lib/client.js                   *
 * ------------------------------------------------------------------ */
function readDictionary() {
	const source = fs.readFileSync(CLIENT_FILE, 'utf8');
	const marker = 'var DICTIONARY = {';
	const start = source.indexOf(marker);
	if (start < 0) throw new Error('DICTIONARY not found in client.js');
	let depth = 0;
	let end = -1;
	for (let i = start + marker.length - 1; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}
	if (end < 0) throw new Error('DICTIONARY is not closed');
	const literal = source.slice(start + 'var DICTIONARY = '.length, end);
	/* eslint-disable no-new-func */
	return new Function('return ' + literal + ';')();
}

const DICTIONARY = readDictionary();

function translate(lang, key, params) {
	const table = DICTIONARY[lang] || DICTIONARY.en;
	let value = table[key];
	if (typeof value !== 'string') return 'MISSING:' + key;
	if (!params) return value;
	return value.replace(/\{(\w+)\}/g, function (match, name) {
		return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
	});
}

const tx = function (key, params) {
	return translate('en', key, params);
};

/* ------------------------------------------------------------------ *
 * A React stand-in: enough of the API for the two files under test.   *
 * ------------------------------------------------------------------ */
function createMiniReact() {
	const hooks = [];
	let index = 0;
	let pendingEffects = [];
	let rendering = false;
	let pendingRender = false;
	let rootComponent = null;
	let rootProps = null;
	let currentTree = null;
	let scheduled = false;
	let idCounter = 0;

	const React = {};

	function slot() {
		const i = index;
		index += 1;
		if (!hooks[i]) hooks[i] = { init: false };
		return hooks[i];
	}

	function sameDeps(a, b) {
		if (!a || !b) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (!Object.is(a[i], b[i])) return false;
		}
		return true;
	}

	React.createElement = function (type, props) {
		const children = Array.prototype.slice.call(arguments, 2);
		const next = Object.assign({}, props || {});
		if (children.length === 1) next.children = children[0];
		else if (children.length > 1) next.children = children;
		return { type, props: next };
	};

	React.useState = function (initial) {
		const s = slot();
		if (!s.init) {
			s.init = true;
			s.value = typeof initial === 'function' ? initial() : initial;
		}
		const set = function (value) {
			const next = typeof value === 'function' ? value(s.value) : value;
			if (Object.is(next, s.value)) return;
			s.value = next;
			schedule();
		};
		return [s.value, set];
	};

	React.useRef = function (initial) {
		const s = slot();
		if (!s.init) {
			s.init = true;
			s.value = { current: initial };
		}
		return s.value;
	};

	React.useMemo = function (fn, deps) {
		const s = slot();
		if (!s.init || !sameDeps(s.deps, deps)) {
			s.value = fn();
			s.deps = deps;
			s.init = true;
		}
		return s.value;
	};

	React.useId = function () {
		const s = slot();
		if (!s.init) {
			s.init = true;
			idCounter += 1;
			s.value = 'gdw-id-' + idCounter;
		}
		return s.value;
	};

	React.useEffect = function (fn, deps) {
		const s = slot();
		const first = !s.init;
		s.init = true;
		const changed = first || !sameDeps(s.deps, deps);
		s.deps = deps;
		if (changed) pendingEffects.push({ slot: s, fn });
	};

	function resolve(element) {
		if (element === null || element === undefined || typeof element === 'boolean') return null;
		if (typeof element === 'string' || typeof element === 'number') {
			return { type: '#text', props: {}, children: [], text: String(element) };
		}
		if (Array.isArray(element)) {
			return element.map(resolve).filter((node) => node !== null);
		}
		const type = element.type;
		if (typeof type === 'function') return resolve(type(element.props));
		const props = Object.assign({}, element.props);
		const children = resolve(props.children);
		return { type, props, children };
	}

	function runEffects() {
		const list = pendingEffects;
		pendingEffects = [];
		for (const entry of list) {
			if (entry.slot.cleanup) {
				try {
					entry.slot.cleanup();
				} catch (error) {
					/* a failing cleanup must not stop the test */
				}
				entry.slot.cleanup = null;
			}
			const result = entry.fn();
			if (typeof result === 'function') entry.slot.cleanup = result;
		}
	}

	function renderPass() {
		index = 0;
		pendingEffects = [];
		const element = rootComponent(rootProps);
		const tree = resolve(element);
		currentTree = tree;
		runEffects();
		return tree;
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		Promise.resolve().then(function () {
			scheduled = false;
			if (rendering) {
				pendingRender = true;
				return;
			}
			renderPass();
			if (pendingRender) {
				pendingRender = false;
				renderPass();
			}
		});
	}

	function mount(component, props) {
		rootComponent = component;
		rootProps = props || {};
		currentTree = renderPass();
		return currentTree;
	}

	function rerender() {
		currentTree = renderPass();
		return currentTree;
	}

	return {
		React,
		mount,
		rerender,
		get tree() {
			return currentTree;
		},
	};
}

/* ------------------------------------------------------------------ *
 * Tree helpers                                                       *
 * ------------------------------------------------------------------ */
function walk(node, visit) {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node === 'object') {
		visit(node);
		walk(node.children, visit);
	}
}

function textOf(node) {
	let out = '';
	walk(node, (item) => {
		if (item.type === '#text') out += item.text;
	});
	return out;
}

function allNodes(tree) {
	const out = [];
	walk(tree, (item) => out.push(item));
	return out;
}

function findByText(tree, text) {
	return allNodes(tree).filter((node) => textOf(node) === text);
}

function buttons(tree) {
	return allNodes(tree).filter((node) => node.type === 'button');
}

function buttonByText(tree, text) {
	return buttons(tree).filter((node) => textOf(node) === text);
}

function hasText(tree, text) {
	return textOf(tree).indexOf(text) >= 0;
}

function detailsNodes(tree) {
	return allNodes(tree).filter((node) => node.type === 'details');
}

function insideDetails(tree, text) {
	for (const details of detailsNodes(tree)) {
		if (textOf(details).indexOf(text) >= 0) return true;
	}
	return false;
}

/**
 * The text the user can read without opening a disclosure.
 *
 * @param {object} tree - the rendered tree.
 * @returns {string} the text that is not inside a closed block.
 */
function textOutsideDetails(tree) {
	let out = '';
	function visit(node, inside) {
		if (node === null || node === undefined) return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child, inside);
			return;
		}
		if (node.type === 'style') return;
		if (node.type === '#text') {
			if (!inside) out += node.text;
			return;
		}
		visit(node.children, inside || node.type === 'details');
	}
	visit(tree, false);
	return out;
}

function fields(tree) {
	return allNodes(tree).filter((node) => node.type === 'input');
}

function inputByLabel(tree, label) {
	const labels = allNodes(tree).filter((node) => node.type === 'label');
	const match = labels.filter((node) => textOf(node) === label)[0];
	if (!match) return null;
	const id = match.props.htmlFor;
	if (!id) return null;
	return fields(tree).filter((node) => node.props.id === id)[0] || null;
}

/* ------------------------------------------------------------------ *
 * The fake host                                                      *
 * ------------------------------------------------------------------ */
function createHost(detectValue) {
	const calls = [];
	const opened = [];
	const fakeWindow = {
		location: { href: '' },
		close() {
			opened.push('closed');
		},
	};
	function rpc(method, payload) {
		calls.push({ method, payload });
		if (method === 'onboarding/detect') {
			return Promise.resolve(detectValue);
		}
		if (method === 'oauth/start') {
			return Promise.resolve({ flowId: 'flow-1', authUrl: 'https://accounts.google.test/auth' });
		}
		if (method === 'oauth/status') {
			return Promise.resolve({ status: 'pending' });
		}
		return Promise.resolve({});
	}
	return { calls, rpc, opened, fakeWindow, detectValue };
}

/* ------------------------------------------------------------------ *
 * The shared UI pieces the wizard asks for                           *
 * ------------------------------------------------------------------ */
function makeDeps(React, host) {
	const h = React.createElement;
	const Button = function (props) {
		return h('button', Object.assign({ type: 'button' }, props));
	};
	const Field = function (props) {
		return h(
			'div',
			{ className: 'gdw-field' },
			h('label', null, props.label),
			h('input', {
				type: props.type || 'text',
				value: props.value,
				placeholder: props.placeholder,
				readOnly: true,
			}),
			props.hint ? h('div', { className: 'gdw-field-hint' }, props.hint) : null,
		);
	};
	const Status = function (props) {
		return h('div', { className: 'gdw-status', 'data-tone': props.tone }, props.children);
	};
	const Dialog = function (props) {
		return h('div', { className: 'gdw-dialog' }, h('h2', null, props.title), props.children);
	};
	const Icon = function (props) {
		return h('span', { className: 'gdw-icon' }, props.name);
	};
	return {
		React,
		h,
		tx,
		rpc: host.rpc,
		Button,
		Field,
		Status,
		Dialog,
		Icon,
	};
}

/* ------------------------------------------------------------------ *
 * Loading the wizard chunk                                           *
 * ------------------------------------------------------------------ */
function loadWizard(React, host) {
	const source = fs.readFileSync(WIZARD_FILE, 'utf8');
	let spec = null;
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(value) {
					spec = value;
				},
			},
			open() {
				host.opened.push('opened');
				return host.fakeWindow;
			},
		},
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		document: { activeElement: null },
		/* The wizard reads a downloaded client file with a FileReader. */
		FileReader: class {
			readAsText() {
				this.result = globalThis.__gdFileContent;
				this.onload();
			}
		},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: WIZARD_FILE });
	if (!spec) throw new Error('the wizard chunk did not register itself');
	const module = { exports: {} };
	const requireFn = function (name) {
		if (name === 'react') return React;
		throw new Error('unknown module: ' + name);
	};
	const exported = spec.factory(requireFn);
	return exported.createOnboardingWizard(makeDeps(React, host));
}

async function flush(times) {
	const rounds = times || 6;
	for (let i = 0; i < rounds; i += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/* ------------------------------------------------------------------ *
 * A mounted wizard                                                   *
 * ------------------------------------------------------------------ */
async function mountWizard(detectValue) {
	const host = createHost(detectValue);
	const mini = createMiniReact();
	const Wizard = loadWizard(mini.React, host);
	const tree = mini.mount(Wizard, { onClose() {}, onAdded() {} });
	await flush();
	return { host, mini, tree: mini.tree, wizard: Wizard };
}

async function openAccountRoute(mounted) {
	const card = buttons(mounted.mini.tree).filter(
		(node) => (node.props.className || '').indexOf('gdw-wizard-choice') >= 0,
	)[0];
	if (!card) throw new Error('the chooser has no card');
	card.props.onClick();
	await flush();
	return mounted.mini.tree;
}

/* ================================================================== *
 * 1. The built-in path: one step, no console, no client id sent     *
 * ================================================================== */
await test('built-in: the Google-account route hides the console steps', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	const tree = mounted.mini.tree;
	const visible = textOutsideDetails(tree);
	const step1 = translate('en', 'wizard.oauth.step1a');
	ok(visible.indexOf(step1) < 0, 'the console steps are gone');
	ok(visible.indexOf(translate('en', 'wizard.oauth.step1b')) < 0, 'step 1b is gone');
	ok(visible.indexOf(translate('en', 'wizard.oauth.step1c')) < 0, 'step 1c is gone');
	ok(visible.indexOf(translate('en', 'wizard.oauth.step1d')) < 0, 'step 1d is gone');
	ok(visible.indexOf(translate('en', 'wizard.oauth.step1e')) < 0, 'step 1e is gone');
	ok(visible.indexOf(translate('en', 'wizard.desktop.file')) < 0, 'the file picker is gone');
	ok(visible.indexOf(translate('en', 'wizard.desktop.console')) < 0, 'the console link is gone');
	ok(visible.indexOf(translate('en', 'wizard.oauth.testing')) < 0, 'the test-user note is gone');
	ok(
		visible.indexOf(translate('en', 'wizard.desktop.dont')) < 0,
		'the “do not choose web app” note is gone',
	);
});

await test('built-in: the sign-in keeps the permissions, the note and the button', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	const tree = mounted.mini.tree;
	ok(hasText(tree, translate('en', 'wizard.oauth.permissions')), 'the permissions line is there');
	ok(hasText(tree, translate('en', 'wizard.oauth.unverified')), 'the unverified note is there');
	ok(hasText(tree, translate('en', 'wizard.accountName.label')), 'the account-name field is there');
	const starts = buttonByText(tree, translate('en', 'oauth.start'));
	eq(starts.length, 1, 'there is one sign-in button');
	ok(starts[0] && !starts[0].props.disabled, 'the sign-in button is ready');
});

await test('built-in: the scope url stays behind the technical details', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	const tree = mounted.mini.tree;
	const scope = translate('en', 'wizard.oauth.scopeDetail');
	ok(hasText(tree, scope), 'the scope is on the screen');
	ok(insideDetails(tree, scope), 'the scope is inside a disclosure');
	const detailsList = detailsNodes(tree);
	ok(
		detailsList.some((node) => textOf(node).indexOf(translate('en', 'wizard.technical')) >= 0),
		'the technical details disclosure is there',
	);
});

await test('built-in: the sign-in sends no client id and no secret', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	const start = buttonByText(mounted.mini.tree, translate('en', 'oauth.start'))[0];
	start.props.onClick();
	await flush();
	const starts = mounted.host.calls.filter((call) => call.method === 'oauth/start');
	eq(starts.length, 1, 'one sign-in was started');
	const payload = starts[0].payload;
	ok(payload && typeof payload === 'object', 'the sign-in has a payload');
	ok(!('clientId' in payload), 'the payload carries no client id');
	ok(!('clientSecret' in payload), 'the payload carries no client secret');
	ok(typeof payload.name === 'string' && payload.name.length > 0, 'the payload carries a name');
});

await test('built-in: the browser window is opened from the click', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	const start = buttonByText(mounted.mini.tree, translate('en', 'oauth.start'))[0];
	start.props.onClick();
	await flush();
	ok(mounted.host.opened.indexOf('opened') >= 0, 'a window was opened');
	eq(mounted.host.fakeWindow.location.href, 'https://accounts.google.test/auth', 'the window shows the sign-in');
});

await test('built-in: the console route is one disclosure away', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	const tree = mounted.mini.tree;
	const own = detailsNodes(tree).filter(
		(node) => textOf(node).indexOf(translate('en', 'wizard.oauth.ownClient.title')) >= 0,
	);
	eq(own.length, 1, 'there is one “use your own client” disclosure');
	ok(
		insideDetails(tree, translate('en', 'wizard.oauth.step1a')),
		'the console steps are inside the disclosure',
	);
	ok(insideDetails(tree, translate('en', 'wizard.desktop.file')), 'the file picker is inside it too');
});

/* ================================================================== *
 * 2. Without the built-in client: everything is as it was             *
 * ================================================================== */
await test('no built-in client: the console steps are still there', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: false },
	});
	await openAccountRoute(mounted);
	const tree = mounted.mini.tree;
	ok(hasText(tree, translate('en', 'wizard.oauth.step1a')), 'step 1a is there');
	ok(hasText(tree, translate('en', 'wizard.oauth.step1e')), 'step 1e is there');
	ok(hasText(tree, translate('en', 'wizard.desktop.file')), 'the file picker is there');
	ok(hasText(tree, translate('en', 'wizard.oauth.testing')), 'the test-user note is there');
	ok(hasText(tree, translate('en', 'wizard.desktop.dont')), 'the “do not choose web app” note is there');
});

await test('no built-in client: the button waits for the client id and the secret', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: false },
	});
	await openAccountRoute(mounted);
	const start = buttonByText(mounted.mini.tree, translate('en', 'oauth.start'))[0];
	ok(start && start.props.disabled, 'the button is disabled without a client');
});

await test('no built-in client: the user’s own client is sent', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: false },
	});
	await openAccountRoute(mounted);
	/* Fill the form the way the user does: through the fields. */
	const idField = allNodes(mounted.mini.tree).filter(
		(node) => node.type === 'input' && node.props.value === '',
	)[0];
	ok(!!idField, 'the client id field exists');
	const secretInput = allNodes(mounted.mini.tree).filter(
		(node) => node.type === 'input' && node.props.type === 'password',
	)[0];
	ok(!!secretInput, 'the secret field exists');
	/* The Field component in this stand-in keeps the value in props, so the
	 * values are set through the react state by firing the real change. */
	const idFieldNode = fields(mounted.mini.tree).filter((node) => node.props.id)[0];
	ok(!!idFieldNode, 'the client id input is rendered');
	/* The wizard keeps the id and the secret in its own state, so the
	 * simplest honest way to fill them is the file the user picks. */
	await fillThroughFile(mounted, 'client-secret-value');
	await flush();
	const start = buttonByText(mounted.mini.tree, translate('en', 'oauth.start'))[0];
	ok(start && !start.props.disabled, 'the button is ready once the file is read');
	start.props.onClick();
	await flush();
	const starts = mounted.host.calls.filter((call) => call.method === 'oauth/start');
	eq(starts.length, 1, 'one sign-in was started');
	eq(starts[0].payload.clientId, 'client-id-value', 'the client id is sent');
	eq(starts[0].payload.clientSecret, 'client-secret-value', 'the secret is sent');
});

/**
 * Put a downloaded client file into the wizard, the way the user does.
 *
 * @param {object} mounted - the mounted wizard.
 * @param {string} secret - the secret inside the file.
 */
async function fillThroughFile(mounted, secret) {
	/* The wizard reads the file with a FileReader, so the file is faked
	 * here and the same code path runs. */
	const files = [
		{
			name: 'client_secret.json',
			installed: {
				client_id: 'client-id-value',
				client_secret: secret,
			},
		},
	];
	/* The file input lives inside the “own client” disclosure. */
	const input = fields(mounted.mini.tree).filter((node) => node.props.type === 'file')[0];
	ok(!!input, 'the file input is rendered');
	globalThis.__gdFileContent = JSON.stringify(files[0]);
	input.props.onChange({ target: { files } });
	await flush();
}

/* ================================================================== *
 * 3. “Use your own client” while the built-in client is available   *
 * ================================================================== */
await test('built-in: the user can still use a client of their own', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	await fillThroughFile(mounted, 'own-secret');
	await flush();
	const start = buttonByText(mounted.mini.tree, translate('en', 'oauth.start'))[0];
	ok(start && !start.props.disabled, 'the button is ready with the user’s own client');
	start.props.onClick();
	await flush();
	const starts = mounted.host.calls.filter((call) => call.method === 'oauth/start');
	eq(starts.length, 1, 'one sign-in was started');
	eq(starts[0].payload.clientId, 'client-id-value', 'the client id of the user is sent');
	eq(starts[0].payload.clientSecret, 'own-secret', 'the secret of the user is sent');
});

/* ================================================================== *
 * 4. The step indicator                                              *
 * ================================================================== */
function indicatorSteps(tree) {
	const list = allNodes(tree).filter((node) => {
		const className = node.props.className || '';
		return className.split(/\s+/).indexOf('gdw-wizard-progress-step') >= 0;
	});
	return list.map((node) => textOf(node));
}

await test('the step indicator names the three steps of the wizard', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: false },
	});
	const steps = indicatorSteps(mounted.mini.tree);
	eq(steps.length, 3, 'the list has three steps');
	eq(steps[0], translate('en', 'wizard.step.1'), 'step 1');
	eq(steps[1], translate('en', 'wizard.step.2'), 'step 2');
	eq(steps[2], translate('en', 'wizard.step.3'), 'step 3');
	ok(
		hasText(mounted.mini.tree, translate('en', 'wizard.step.label', { current: '1', total: '3' })),
		'the counter says step 1 of 3',
	);
});

await test('the step indicator follows the built-in route', async () => {
	const mounted = await mountWizard({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	await openAccountRoute(mounted);
	const steps = indicatorSteps(mounted.mini.tree);
	eq(steps.length, 3, 'the list still has three steps');
	eq(steps[0], translate('en', 'wizard.step.1'), 'step 1 is still “choose how to connect”');
	eq(steps[1], translate('en', 'wizard.oauth.step2'), 'step 2 is the sign-in itself');
	eq(steps[2], translate('en', 'wizard.step.3'), 'step 3 is “connected”');
	ok(
		steps.indexOf(translate('en', 'wizard.step.2')) < 0,
		'the list does not promise a setup the user is not doing',
	);
	ok(
		hasText(mounted.mini.tree, translate('en', 'wizard.step.label', { current: '2', total: '3' })),
		'the counter says step 2 of 3',
	);
	const current = allNodes(mounted.mini.tree).filter((node) => node.props['aria-current'] === 'step');
	eq(current.length, 1, 'one step is the current one');
	eq(textOf(current[0]), translate('en', 'wizard.oauth.step2'), 'the current step is the sign-in');
});

/* ================================================================== *
 * 5. The locale dictionaries                                          *
 * ================================================================== */
await test('every key the wizard uses exists in en and in zh', async () => {
	const source = fs.readFileSync(WIZARD_FILE, 'utf8');
	const keys = new Set();
	const pattern = /tx\('([^']+)'/g;
	let match = pattern.exec(source);
	while (match) {
		keys.add(match[1]);
		match = pattern.exec(source);
	}
	ok(keys.size > 20, 'the wizard uses a fair number of keys (' + keys.size + ')');
	const missingEn = [];
	const missingZh = [];
	const emptyEn = [];
	const emptyZh = [];
	for (const key of keys) {
		if (typeof DICTIONARY.en[key] !== 'string') missingEn.push(key);
		else if (!DICTIONARY.en[key].trim()) emptyEn.push(key);
		if (typeof DICTIONARY.zh[key] !== 'string') missingZh.push(key);
		else if (!DICTIONARY.zh[key].trim()) emptyZh.push(key);
	}
	eq(missingEn.join(','), '', 'no key is missing in en');
	eq(missingZh.join(','), '', 'no key is missing in zh');
	eq(emptyEn.join(','), '', 'no key is empty in en');
	eq(emptyZh.join(','), '', 'no key is empty in zh');
});

await test('the new strings exist in en and in zh', async () => {
	const newKeys = [
		'wizard.oauth.ownClient.title',
		'wizard.oauth.ownClient.hint',
		'wizard.oauth.hint.testUserBuiltin',
	];
	for (const key of newKeys) {
		ok(typeof DICTIONARY.en[key] === 'string' && DICTIONARY.en[key].trim() !== '', key + ' exists in en');
		ok(typeof DICTIONARY.zh[key] === 'string' && DICTIONARY.zh[key].trim() !== '', key + ' exists in zh');
	}
});

await test('en and zh have the same keys', async () => {
	const enKeys = Object.keys(DICTIONARY.en).sort();
	const zhKeys = Object.keys(DICTIONARY.zh).sort();
	const onlyEn = enKeys.filter((key) => zhKeys.indexOf(key) < 0);
	const onlyZh = zhKeys.filter((key) => enKeys.indexOf(key) < 0);
	eq(onlyEn.join(','), '', 'no key is only in en');
	eq(onlyZh.join(','), '', 'no key is only in zh');
});

await test('the new strings do not talk about clients and secrets', async () => {
	const forbidden = ['oauth client id', 'client secret', 'impersonate', 'domain-wide delegation'];
	const newKeys = [
		'wizard.oauth.ownClient.title',
		'wizard.oauth.ownClient.hint',
		'wizard.oauth.hint.testUserBuiltin',
	];
	for (const key of newKeys) {
		for (const lang of ['en', 'zh']) {
			const value = String(DICTIONARY[lang][key] || '').toLowerCase();
			for (const word of forbidden) {
				ok(value.indexOf(word) < 0, key + ' (' + lang + ') does not say “' + word + '”');
			}
		}
	}
});

/* ================================================================== *
 * 6. The settings section’s own add-account dialog                   *
 * ================================================================== */
function loadClientBundle(React, host, chunkFails) {
	const source = fs.readFileSync(CLIENT_FILE, 'utf8');
	let spec = null;
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(value) {
					spec = value;
				},
			},
		},
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		document: { activeElement: null },
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: CLIENT_FILE });
	const module = { exports: {} };
	const requireFn = function (name) {
		if (name === 'react') return React;
		throw new Error('unknown module: ' + name);
	};
	requireFn.async = function () {
		if (chunkFails) return Promise.reject(new Error('the chunk is not there'));
		return Promise.reject(new Error('the chunk is not there'));
	};
	const exported = spec.factory(requireFn);

	const registrations = {};
	const ctx = {
		effect(fn) {
			try {
				const cleanup = fn();
				if (typeof cleanup === 'function') cleanup();
			} catch (error) {
				/* an effect that fails must not stop the test */
			}
		},
		locale: {
			bind() {
				return function (key, params) {
					return translate('en', key, params);
				};
			},
			subscribe() {
				return function () {};
			},
			register() {},
		},
		connection: {
			rpc: {
				call(channel, method, payload) {
					const endpoint = String(method)
						.split('/')
						.slice(-2)
						.join('/');
					host.calls.push({ method: endpoint, payload });
					/* The plugin's rpc helper expects the {ok, value} envelope. */
					if (endpoint === 'onboarding/detect') {
						return Promise.resolve({ ok: true, value: host.detectValue });
					}
					if (endpoint === 'accounts/list') {
						return Promise.resolve({ ok: true, value: { accounts: [] } });
					}
					if (endpoint === 'oauth/start') {
						return Promise.resolve({
							ok: true,
							value: { flowId: 'flow-1', authUrl: 'https://accounts.google.test/auth' },
						});
					}
					return Promise.resolve({ ok: true, value: {} });
				},
			},
		},
		slots: {
			inject(name, fn) {
				registrations[name] = fn();
			},
			register(meta, component) {
				return { meta, component };
			},
		},
		get() {
			return null;
		},
	};
	exported.apply(ctx);
	return registrations;
}

await test('the settings dialog uses the built-in client too', async () => {
	const host = createHost({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: true },
	});
	const mini = createMiniReact();
	const registrations = loadClientBundle(mini.React, host, true);
	const section = registrations['settings.section'];
	ok(!!section, 'the settings section is registered');
	mini.mount(section.component, {});
	await flush();
	/* Open the “add account” tab. */
	const addButtons = buttonByText(mini.tree, translate('en', 'accounts.add'));
	ok(addButtons.length >= 1, 'there is an “add account” button');
	addButtons[0].props.onClick();
	await flush(10);
	const tree = mini.tree;
	ok(hasText(tree, translate('en', 'oauth.start')), 'the sign-in button is there');
	ok(insideDetails(tree, translate('en', 'oauth.clientId.label')), 'the client id is behind a disclosure');
	ok(insideDetails(tree, translate('en', 'oauth.clientSecret.label')), 'the secret is behind a disclosure too');
	/* The dialog asks for a name for the account. */
	const nameField = inputByLabel(tree, translate('en', 'oauth.name.label'));
	ok(!!nameField, 'the account-name field is there');
	nameField.props.onChange({ target: { value: 'my-drive' } });
	await flush();
	const start = buttonByText(mini.tree, translate('en', 'oauth.start'))[0];
	ok(start && !start.props.disabled, 'the sign-in button is ready with the built-in client');
	start.props.onClick();
	await flush();
	const starts = host.calls.filter((call) => call.method === 'oauth/start');
	eq(starts.length, 1, 'one sign-in was started');
	ok(!('clientId' in starts[0].payload), 'the payload carries no client id');
	ok(!('clientSecret' in starts[0].payload), 'the payload carries no secret');
});

await test('the settings dialog still asks for a client without the built-in one', async () => {
	const host = createHost({
		gcloud: { available: false },
		oauthClients: [],
		serviceAccounts: [],
		builtinClient: { available: false },
	});
	const mini = createMiniReact();
	const registrations = loadClientBundle(mini.React, host, true);
	const section = registrations['settings.section'];
	mini.mount(section.component, {});
	await flush();
	const addButtons = buttonByText(mini.tree, translate('en', 'accounts.add'));
	addButtons[0].props.onClick();
	await flush(10);
	const tree = mini.tree;
	const start = buttonByText(tree, translate('en', 'oauth.start'))[0];
	ok(start && start.props.disabled, 'the button waits for the client id and the secret');
});

/* ------------------------------------------------------------------ */
console.log('');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failures.length);
if (failures.length) {
	console.log('');
	for (const failure of failures) console.log('FAIL  ' + failure);
}
process.exit(failures.length ? 1 : 0);
