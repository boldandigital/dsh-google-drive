/**
 * The settings navigation icon.
 *
 * A plugin that renders a Settings section should show its own artwork in the
 * Settings navigation, the same mark the Plugin Manager shows for the plugin
 * row. Two things can go wrong, and both are invisible in the plugin's own
 * code:
 *
 *   - the plugin registers no `settings.section.icon` at all, so the shell
 *     keeps its default glyph and every plugin looks the same;
 *   - the plugin registers a generic stroke icon instead of its artwork.
 *
 * The icon only renders when its registration id equals the section's id, so
 * the test checks that too.
 *
 *   node --test test/settings-icon.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'lib', 'client.js');

/** The plugin's package name, which is also its module id. */
const PACKAGE = 'dsh-google-drive';

/** A React stub whose hooks refuse to run outside a component render. */
function reactStub() {
	return {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState: () => { throw new Error('Invalid hook call: useState outside a component render'); },
		useEffect: () => { throw new Error('Invalid hook call: useEffect outside a component render'); },
		useRef: () => { throw new Error('Invalid hook call: useRef outside a component render'); },
		useMemo: () => { throw new Error('Invalid hook call: useMemo outside a component render'); },
	};
}

/** Load the client bundle and return its module exports. */
async function loadBundle() {
	let registration = null;
	globalThis.window = {
		__ModuleLoader__: {
			load(spec) { registration = spec; },
		},
	};
	await import(`file://${bundlePath}?t=${Date.now()}`);
	assert.ok(registration, 'the bundle did not register itself with the module loader');
	assert.equal(registration.id, PACKAGE, 'the factory id must equal the package id');
	// The bundle loads sibling chunks lazily through `require.async`. The
	// settings sections it registers do not need them, so an empty module is
	// enough.
	const requireStub = (id) => {
		if (id === 'react') return reactStub();
		throw new Error(`unexpected require("${id}")`);
	};
	requireStub.async = () => Promise.resolve({});
	return registration.factory(requireStub);
}

/** A client context that records what the module registers. */
function contextStub() {
	const registered = [];
	const injected = [];
	return {
		registered,
		injected,
		effect(fn) { return fn(); },
		locale: {
			register(ns, dicts) { this.dicts = { ns, dicts }; return () => {}; },
			bind() { return (key) => key; },
		},
		slots: {
			inject(name, factory) { injected.push({ name, factory }); },
			register(options, component) { registered.push({ options, component }); return () => {}; },
		},
		connection: {},
	};
}

test('the settings section and its icon are both registered', async () => {
	const module = await loadBundle();
	const ctx = contextStub();
	module.apply(ctx);
	for (const entry of ctx.injected) entry.factory();

	const section = ctx.registered.find((entry) => entry.options.name === 'settings.section');
	const icon = ctx.registered.find((entry) => entry.options.name === 'settings.section.icon');
	assert.ok(section, 'no settings.section contribution');
	assert.ok(icon, 'no settings.section.icon contribution — the shell keeps its default glyph');
	assert.equal(icon.options.id, section.options.id, 'the icon id must match the section id');
});

test('the settings icon is the plugin artwork', async () => {
	const module = await loadBundle();
	const ctx = contextStub();
	module.apply(ctx);
	for (const entry of ctx.injected) entry.factory();

	const icon = ctx.registered.find((entry) => entry.options.name === 'settings.section.icon');
	const element = icon.component({ size: 16 });
	assert.equal(
		element.props.src?.startsWith('data:image/svg+xml;base64,'),
		true,
		'the settings icon is not the plugin artwork',
	);
});
