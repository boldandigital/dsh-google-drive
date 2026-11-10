/**
 * Run every test suite.
 *
 *   npm test
 *
 * The suites live in this folder rather than in a temporary directory, so
 * they survive a restart and can be run by anyone who checks the plugin out.
 */

import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entries = await readdir(here);
const suites = entries
	.filter((name) => name.endsWith('.test.mjs'))
	.sort();

let failed = 0;
for (const name of suites) {
	const result = spawnSync(process.execPath, [path.join(here, name)], { stdio: 'inherit' });
	if (result.status !== 0) failed += 1;
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
